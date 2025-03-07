import Logger from '@joplin/utils/Logger';
import shim from '../../shim';
import { PluginManifest } from './utils/types';
const md5 = require('md5');
import { compareVersions } from 'compare-versions';
import isCompatible from './utils/isCompatible';
import { AppType } from '../../models/Setting';

const logger = Logger.create('RepositoryApi');

interface ReleaseAsset {
	name: string;
	browser_download_url: string;
}

interface Release {
	upload_url: string;
	assets: ReleaseAsset[];
}

export enum InstallMode {
	Restricted,
	Default,
}

export interface AppInfo {
	version: string;
	type: AppType;
}

const findWorkingGitHubUrl = async (defaultContentUrl: string): Promise<string> => {
	// From: https://github.com/laurent22/joplin/issues/5161#issuecomment-921642721

	const mirrorUrls = [
		defaultContentUrl,
		'https://cdn.staticaly.com/gh/joplin/plugins/master',
		'https://ghproxy.com/https://raw.githubusercontent.com/joplin/plugins/master',
		'https://cdn.jsdelivr.net/gh/joplin/plugins@master',
		'https://raw.fastgit.org/joplin/plugins/master',
	];

	for (const mirrorUrl of mirrorUrls) {
		try {
			// We try to fetch .gitignore, which is smaller than the whole manifest
			await shim.fetch(`${mirrorUrl}/.gitignore`);
		} catch (error) {
			logger.info(`findWorkingMirror: Could not connect to ${mirrorUrl}:`, error);
			continue;
		}

		logger.info(`findWorkingMirror: Using: ${mirrorUrl}`);

		return mirrorUrl;
	}

	logger.info('findWorkingMirror: Could not find any working GitHub URL');

	return defaultContentUrl;
};

export default class RepositoryApi {

	// As a base URL, this class can support either a remote repository or a
	// local one (a directory path), which is useful for testing.
	//
	// For now, if the baseUrl is an actual URL it's assumed it's a GitHub repo
	// URL, such as https://github.com/joplin/plugins
	//
	// Later on, other repo types could be supported.
	private baseUrl_: string;
	private tempDir_: string;
	private readonly installMode_: InstallMode;
	private readonly appType_: AppType;
	private readonly appVersion_: string;
	private release_: Release = null;
	private manifests_: PluginManifest[] = null;
	private githubApiUrl_: string;
	private contentBaseUrl_: string;
	private isUsingDefaultContentUrl_ = true;
	private lastInitializedTime_ = 0;

	public constructor(baseUrl: string, tempDir: string, appInfo: AppInfo, installMode: InstallMode) {
		this.installMode_ = installMode;
		this.appType_ = appInfo.type;
		this.appVersion_ = appInfo.version;
		this.baseUrl_ = baseUrl;
		this.tempDir_ = tempDir;
	}

	public static ofDefaultJoplinRepo(tempDirPath: string, appInfo: AppInfo, installMode: InstallMode) {
		return new RepositoryApi('https://github.com/joplin/plugins', tempDirPath, appInfo, installMode);
	}

	public async initialize() {
		// https://github.com/joplin/plugins
		// https://api.github.com/repos/joplin/plugins/releases
		this.githubApiUrl_ = this.baseUrl_.replace(/^(https:\/\/)(github\.com\/)(.*)$/, '$1api.$2repos/$3');
		const defaultContentBaseUrl = this.isLocalRepo ? this.baseUrl_ : `${this.baseUrl_.replace(/github\.com/, 'raw.githubusercontent.com')}/master`;

		const canUseMirrors = this.installMode_ === InstallMode.Default && !this.isLocalRepo;
		this.contentBaseUrl_ = canUseMirrors ? await findWorkingGitHubUrl(defaultContentBaseUrl) : defaultContentBaseUrl;
		this.isUsingDefaultContentUrl_ = this.contentBaseUrl_ === defaultContentBaseUrl;

		await this.loadManifests();
		await this.loadRelease();

		this.lastInitializedTime_ = Date.now();
	}

	public async reinitialize() {
		// Refresh at most once per minute
		if (Date.now() - this.lastInitializedTime_ > 5 * 60000) {
			await this.initialize();
		}
	}

	private async loadManifests() {
		const manifestsText = await this.fetchText('manifests.json');
		try {
			const manifests = JSON.parse(manifestsText);
			if (!manifests) throw new Error('Invalid or missing JSON');

			this.manifests_ = Object.keys(manifests).map(id => {
				const m: PluginManifest = manifests[id];
				// If we don't control the repository, we can't recommend
				// anything on it since it could have been modified.
				if (!this.isUsingDefaultContentUrl) m._recommended = false;
				return m;
			});
		} catch (error) {
			throw new Error(`Could not parse JSON: ${error.message}`);
		}
	}

	public get isUsingDefaultContentUrl() {
		return this.isUsingDefaultContentUrl_;
	}

	private get githubApiUrl(): string {
		return this.githubApiUrl_;
	}

	public get contentBaseUrl(): string {
		if (this.isLocalRepo) {
			return this.baseUrl_;
		} else {
			return this.contentBaseUrl_;
		}
	}

	private async loadRelease() {
		this.release_ = null;

		if (this.isLocalRepo) return;

		try {
			const response = await shim.fetch(`${this.githubApiUrl}/releases`);
			const releases = await response.json();
			if (!releases.length) throw new Error('No release was found');
			this.release_ = releases[0];
		} catch (error) {
			logger.warn('Could not load release - files will be downloaded from the repository directly:', error);
		}
	}

	private get isLocalRepo(): boolean {
		return this.baseUrl_.indexOf('http') !== 0;
	}

	private assetFileUrl(pluginId: string): string {
		if (this.release_) {
			const asset = this.release_.assets.find(asset => {
				const s = asset.name.split('@');
				s.pop();
				const id = s.join('@');
				return id === pluginId;
			});

			if (asset) return asset.browser_download_url;

			logger.warn(`Could not get plugin from release: ${pluginId}`);
		}

		// If we couldn't get the plugin file from the release, get it directly
		// from the repository instead.
		return this.repoFileUrl(`plugins/${pluginId}/plugin.jpl`);
	}

	private repoFileUrl(relativePath: string): string {
		return `${this.contentBaseUrl}/${relativePath}`;
	}

	private async fetchText(path: string): Promise<string> {
		if (this.isLocalRepo) {
			return shim.fsDriver().readFile(this.repoFileUrl(path), 'utf8');
		} else {
			return shim.fetchText(this.repoFileUrl(path));
		}
	}

	private isBlockedByInstallMode(manifest: PluginManifest) {
		return this.installMode_ === InstallMode.Restricted && manifest._recommended !== true;
	}

	public async search(query: string): Promise<PluginManifest[]> {
		query = query.toLowerCase().trim();

		const manifests = await this.manifests();
		const output: PluginManifest[] = [];

		for (const manifest of manifests) {
			if (this.isBlockedByInstallMode(manifest)) {
				continue;
			}

			for (const field of ['name', 'description']) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Old code before rule was applied
				const v = (manifest as any)[field];
				if (!v) continue;

				if (v.toLowerCase().indexOf(query) >= 0) {
					output.push(manifest);
					break;
				}
			}
		}

		output.sort((m1, m2) => {
			const m1Compatible = isCompatible(this.appVersion_, this.appType_, m1);
			const m2Compatible = isCompatible(this.appVersion_, this.appType_, m2);
			if (m1Compatible && !m2Compatible) return -1;
			if (!m1Compatible && m2Compatible) return 1;
			if (m1._recommended && !m2._recommended) return -1;
			if (!m1._recommended && m2._recommended) return +1;
			return m1.name.toLowerCase() < m2.name.toLowerCase() ? -1 : +1;
		});

		return output;
	}

	// Returns a temporary path, where the plugin has been downloaded to. Temp
	// file should be deleted by caller.
	public async downloadPlugin(pluginId: string): Promise<string> {
		const manifests = await this.manifests();
		const manifest = manifests.find(m => m.id === pluginId);
		if (!manifest) throw new Error(`No manifest for plugin ID "${pluginId}"`);
		if (this.isBlockedByInstallMode(manifest)) throw new Error(`Plugin is blocked by intstallation policy. ID "${pluginId}"`);

		const fileUrl = this.assetFileUrl(manifest.id); // this.repoFileUrl(`plugins/${manifest.id}/plugin.jpl`);
		const hash = md5(Date.now() + Math.random());
		const targetPath = `${this.tempDir_}/${hash}_${manifest.id}.jpl`;

		if (this.isLocalRepo) {
			await shim.fsDriver().copy(fileUrl, targetPath);
		} else {
			const response = await shim.fetchBlob(fileUrl, {
				path: targetPath,
			});

			if (!response.ok) throw new Error(`Could not download plugin "${pluginId}" from "${fileUrl}"`);
		}

		return targetPath;
	}

	public async manifests(): Promise<PluginManifest[]> {
		if (!this.manifests_) throw new Error('Manifests have no been loaded!');
		return this.manifests_;
	}

	public async canBeUpdatedPlugins(installedManifests: PluginManifest[]): Promise<string[]> {
		const output = [];

		for (const manifest of installedManifests) {
			const canBe = await this.pluginCanBeUpdated(manifest.id, manifest.version);
			if (canBe) output.push(manifest.id);
		}

		return output;
	}

	public async pluginCanBeUpdated(pluginId: string, installedVersion: string): Promise<boolean> {
		const manifest = (await this.manifests()).find(m => m.id === pluginId);
		if (!manifest) return false;

		const supportsCurrentAppVersion = compareVersions(installedVersion, manifest.version) < 0 && isCompatible(this.appVersion_, this.appType_, manifest);
		return supportsCurrentAppVersion && !this.isBlockedByInstallMode(manifest);
	}

}
