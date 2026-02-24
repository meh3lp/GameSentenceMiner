/**
 * Dependency downloader — handles downloading and detection of all managed dependencies.
 *
 * Dependencies managed (platform-dependent):
 *   - uv (Win/Linux)
 *   - Python 3.13 venv (all platforms via uv / Homebrew)
 *   - OBS Studio (Windows only)
 *   - FFmpeg (Windows only)
 *   - OneOCR (Windows only)
 *   - Ocenaudio (Windows only)
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BrowserWindow } from 'electron';
import { BASE_DIR, DOWNLOAD_DIR, getPlatform, isWindows, isMacOS, execFileAsync } from '../util.js';
import {
    downloadFile,
    extractArchive,
    flattenDirectory,
    cleanupArchive,
    sendProgressToWindow,
    type ProgressCallback,
} from './utils.js';
import { DependenciesConfig, DependencyEntry, getDependenciesConfig, setDependencyEntry }  from '../store.js';

const execFilePromise = promisify(execFile);

// ============================================================================
// Dependency Metadata
// ============================================================================

export interface DependencyMeta {
    id: keyof DependenciesConfig;
    name: string;
    description: string;
    /** Platforms where this dependency is applicable */
    platforms: NodeJS.Platform[];
    /** Default installation directory */
    defaultPath: string;
    /** Filename(s) to check for existence inside the path */
    checkFiles: string[];
    /** Binary name to search for in system PATH (null = no PATH detection) */
    systemBinary: string | null;
    /** Download URL (may be computed dynamically) */
    getDownloadUrl: () => string | Promise<string>;
    /** Expected size on disk (human-readable, approximate) */
    diskSize: string;
    /** Whether this dep is critical (blocks the app from starting) */
    required: boolean;
    /**
     * Whether this is a system-level package (installed via distro package manager).
     * System packages cannot be browsed/downloaded — the setup UI shows install
     * commands instead, with a "Check Again" button.
     */
    systemPackage?: boolean;
}

function getUvDefaultPath(): string {
    return path.join(BASE_DIR, 'uv');
}

function getPythonVenvDefaultPath(): string {
    return path.join(BASE_DIR, 'python_venv');
}

function getObsDefaultPath(): string {
    return path.join(BASE_DIR, 'obs-studio');
}

function getFfmpegDefaultPath(): string {
    return path.join(BASE_DIR, 'ffmpeg');
}

function getOneocrDefaultPath(): string {
    return path.join(os.homedir(), '.config', 'oneocr');
}

function getOcenaudioDefaultPath(): string {
    return path.join(BASE_DIR, 'ocenaudio');
}

// ---- UV download URL ----
function getUvDownloadUrl(): string {
    const arch = os.arch();
    if (isWindows()) {
        return arch === 'arm64'
            ? 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-pc-windows-msvc.zip'
            : 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip';
    }
    if (isMacOS()) {
        return arch === 'arm64'
            ? 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz'
            : 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz';
    }
    // Linux
    return arch === 'arm64'
        ? 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-unknown-linux-gnu.tar.gz'
        : 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz';
}

function getUvExtractedDirName(): string {
    const arch = os.arch();
    if (isWindows()) {
        return arch === 'arm64' ? 'uv-aarch64-pc-windows-msvc' : 'uv-x86_64-pc-windows-msvc';
    }
    if (isMacOS()) {
        return arch === 'arm64' ? 'uv-aarch64-apple-darwin' : 'uv-x86_64-apple-darwin';
    }
    return arch === 'arm64' ? 'uv-aarch64-unknown-linux-gnu' : 'uv-x86_64-unknown-linux-gnu';
}

// ---- OBS download URL ----
async function getObsDownloadUrl(): Promise<string> {
    const response = await fetch('https://api.github.com/repos/obsproject/obs-studio/releases/latest');
    const release = await response.json() as any;
    const machine = os.arch();
    const suffix = machine === 'arm64' ? 'Windows-arm64.zip' : 'Windows-x64.zip';
    const asset = release.assets?.find((a: any) => a.name.endsWith(suffix));
    if (!asset) throw new Error('OBS download URL not found for this platform');
    return asset.browser_download_url;
}

// ---- FFmpeg download URL ----
function getFfmpegDownloadUrl(): string {
    const machine = os.arch();
    if (machine === 'arm64') {
        return 'https://gsm.beangate.us/ffmpeg-8.0-essentials-shared-win-arm64.zip';
    }
    return 'https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-essentials_build.zip';
}

// ---- OneOCR download URL ----
function getOneocrDownloadUrl(): string {
    return 'https://gsm.beangate.us/oneocr.zip';
}

// ---- Ocenaudio download URL ----
function getOcenaudioDownloadUrl(): string {
    return 'https://www.ocenaudio.com/downloads/ocenaudio_windows64.zip';
}

// ============================================================================
// Build dependency metadata
// ============================================================================

export function getDependencyMetas(): DependencyMeta[] {
    const uvCheckFile = isWindows() ? 'uv.exe' : 'uv';

    const metas: DependencyMeta[] = [
        {
            id: 'uv',
            name: 'uv',
            description: 'Fast Python package manager used to install and manage Python.',
            platforms: ['win32', 'linux', 'darwin'],
            defaultPath: getUvDefaultPath(),
            checkFiles: [uvCheckFile],
            systemBinary: 'uv',
            getDownloadUrl: getUvDownloadUrl,
            diskSize: '~30 MB',
            required: true,
        },
        {
            id: 'obs',
            name: 'OBS Studio',
            description: 'Open Broadcaster Software for game recording.',
            platforms: ['win32'],
            defaultPath: getObsDefaultPath(),
            checkFiles: [path.join('bin', '64bit', 'obs64.exe')],
            systemBinary: null,
            getDownloadUrl: getObsDownloadUrl,
            diskSize: '~300 MB',
            required: false,
        },
        {
            id: 'ffmpeg',
            name: 'FFmpeg',
            description: 'Audio/video processing toolkit for trimming and encoding.',
            platforms: ['win32'],
            defaultPath: getFfmpegDefaultPath(),
            checkFiles: ['ffmpeg.exe', 'ffprobe.exe'],
            systemBinary: 'ffmpeg',
            getDownloadUrl: getFfmpegDownloadUrl,
            diskSize: '~90 MB',
            required: false,
        },
        {
            id: 'oneocr',
            name: 'OneOCR',
            description: 'OCR engine for Japanese text recognition.',
            platforms: ['win32'],
            defaultPath: getOneocrDefaultPath(),
            checkFiles: ['oneocr.dll', 'oneocr.onemodel', 'onnxruntime.dll'],
            systemBinary: null,
            getDownloadUrl: getOneocrDownloadUrl,
            diskSize: '~50 MB',
            required: false,
        },
        {
            id: 'ocenaudio',
            name: 'Ocenaudio',
            description: 'Audio editor for reviewing and editing captured audio.',
            platforms: ['win32'],
            defaultPath: getOcenaudioDefaultPath(),
            checkFiles: ['ocenaudio.exe'],
            systemBinary: null,
            getDownloadUrl: getOcenaudioDownloadUrl,
            diskSize: '~60 MB',
            required: false,
        },
        {
            id: 'portaudio',
            name: 'PortAudio (libportaudio2)',
            description: 'Audio I/O library required by the Python sounddevice module. Install via your system package manager.',
            platforms: ['linux'],
            defaultPath: '',
            checkFiles: [],
            systemBinary: null,
            getDownloadUrl: () => '',
            diskSize: '~1 MB',
            required: true,
            systemPackage: true,
        },
    ];

    // Filter to current platform
    const currentPlatform = process.platform;
    return metas.filter((m) => m.platforms.includes(currentPlatform));
}

// ============================================================================
// Detection
// ============================================================================

/**
 * Check if a dependency is present at a given path by verifying all checkFiles exist.
 */
export function isDependencyInstalledAt(meta: DependencyMeta, depPath: string): boolean {
    if (!depPath || !fs.existsSync(depPath)) return false;
    return meta.checkFiles.every((f) => fs.existsSync(path.join(depPath, f)));
}

/**
 * Search system PATH for a binary. Returns the found path or null.
 */
export async function findInSystemPath(binary: string): Promise<string | null> {
    if (!binary) return null;
    const cmd = isWindows() ? 'where' : 'which';
    try {
        const { stdout } = await execFilePromise(cmd, [binary]);
        const found = stdout.trim().split('\n')[0]?.trim();
        if (found && fs.existsSync(found)) {
            // Return the directory containing the binary
            return path.dirname(found);
        }
    } catch {
        // not found
    }
    return null;
}

// ============================================================================
// Download implementations
// ============================================================================

/**
 * Download and install uv binary.
 */
export async function downloadUv(
    destDir: string,
    onProgress?: ProgressCallback,
): Promise<void> {
    const url = getUvDownloadUrl();
    const fileName = isWindows() ? 'uv.zip' : 'uv.tar.gz';
    const downloadsDir = path.join(BASE_DIR, 'downloads');
    let archivePath: string | undefined;

    try {
        archivePath = await downloadFile(url, downloadsDir, fileName, onProgress);
        await extractArchive(archivePath, destDir);

        // Move binary out of extracted subdirectory
        const extractedDirName = getUvExtractedDirName();
        const extractedDir = path.join(destDir, extractedDirName);
        if (fs.existsSync(extractedDir)) {
            const uvBinary = isWindows() ? 'uv.exe' : 'uv';
            const sourcePath = path.join(extractedDir, uvBinary);
            const destPath = path.join(destDir, uvBinary);
            if (fs.existsSync(sourcePath)) {
                fs.renameSync(sourcePath, destPath);
                fs.rmSync(extractedDir, { recursive: true, force: true });
            }
        }

        // Make executable on Unix
        if (!isWindows()) {
            const uvBin = path.join(destDir, 'uv');
            if (fs.existsSync(uvBin)) {
                fs.chmodSync(uvBin, 0o755);
            }
        }

        console.log(`uv installed successfully at: ${destDir}`);
    } finally {
        if (archivePath) cleanupArchive(archivePath);
    }
}

/**
 * Download and install Python 3.13 venv using uv.
 * Requires uv to already be installed.
 */
export async function downloadPython(
    uvDir: string,
    venvDir: string,
    onProgress?: ProgressCallback,
): Promise<void> {
    const uvBin = isWindows() ? path.join(uvDir, 'uv.exe') : path.join(uvDir, 'uv');
    if (!fs.existsSync(uvBin)) {
        throw new Error(`uv not found at ${uvBin}. Install uv first.`);
    }

    const PYTHON_VERSION = '3.13';

    // Step 1: Install Python via uv
    if (onProgress) onProgress({ percentage: 10, downloaded: 0, total: null });
    console.log(`Installing Python ${PYTHON_VERSION} using uv...`);
    await execFileAsync(uvBin, ['python', 'install', PYTHON_VERSION]);

    // Step 2: Create virtual environment
    if (onProgress) onProgress({ percentage: 40, downloaded: 0, total: null });
    console.log(`Creating virtual environment at ${venvDir}...`);
    fs.mkdirSync(path.dirname(venvDir), { recursive: true });
    await execFileAsync(uvBin, ['venv', '--python', PYTHON_VERSION, '--seed', venvDir]);

    // Step 3: Ensure pip
    if (onProgress) onProgress({ percentage: 60, downloaded: 0, total: null });
    const pythonBin = isWindows()
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python');
    await execFileAsync(pythonBin, ['-m', 'ensurepip', '--upgrade']);

    // Step 4: Upgrade pip
    if (onProgress) onProgress({ percentage: 75, downloaded: 0, total: null });
    await execFileAsync(pythonBin, ['-m', 'pip', 'install', '--upgrade', 'pip']);

    // Step 5: Install uv into venv
    if (onProgress) onProgress({ percentage: 90, downloaded: 0, total: null });
    await execFileAsync(pythonBin, ['-m', 'pip', 'install', 'uv']);

    if (onProgress) onProgress({ percentage: 100, downloaded: 0, total: null });
    console.log(`Python ${PYTHON_VERSION} venv created at: ${venvDir}`);
}

/**
 * Download and install OBS Studio.
 */
export async function downloadObs(
    destDir: string,
    onProgress?: ProgressCallback,
): Promise<void> {
    const url = await getObsDownloadUrl();
    const downloadsDir = path.join(BASE_DIR, 'downloads');
    let archivePath: string | undefined;

    try {
        archivePath = await downloadFile(url, downloadsDir, 'OBS.zip', onProgress);
        fs.mkdirSync(destDir, { recursive: true });
        await extractArchive(archivePath, destDir);

        // Create portable_mode file
        const portableFile = path.join(destDir, 'portable_mode');
        fs.writeFileSync(portableFile, '');

        console.log(`OBS installed successfully at: ${destDir}`);
    } finally {
        if (archivePath) cleanupArchive(archivePath);
    }
}

/**
 * Download and install FFmpeg.
 */
export async function downloadFfmpeg(
    destDir: string,
    onProgress?: ProgressCallback,
): Promise<void> {
    const url = getFfmpegDownloadUrl();
    const downloadsDir = path.join(BASE_DIR, 'downloads');
    let archivePath: string | undefined;

    try {
        archivePath = await downloadFile(url, downloadsDir, 'ffmpeg.zip', onProgress);
        fs.mkdirSync(destDir, { recursive: true });
        await extractArchive(archivePath, destDir);
        flattenDirectory(destDir);
        console.log(`FFmpeg installed successfully at: ${destDir}`);
    } finally {
        if (archivePath) cleanupArchive(archivePath);
    }
}

/**
 * Download and install OneOCR DLLs.
 */
export async function downloadOneocr(
    destDir: string,
    onProgress?: ProgressCallback,
): Promise<void> {
    const url = getOneocrDownloadUrl();
    const downloadsDir = path.join(BASE_DIR, 'downloads');
    let archivePath: string | undefined;

    try {
        archivePath = await downloadFile(url, downloadsDir, 'oneocr.zip', onProgress);
        fs.mkdirSync(destDir, { recursive: true });
        await extractArchive(archivePath, destDir);
        console.log(`OneOCR installed successfully at: ${destDir}`);
    } finally {
        if (archivePath) cleanupArchive(archivePath);
    }
}

/**
 * Download and install Ocenaudio.
 */
export async function downloadOcenaudio(
    destDir: string,
    onProgress?: ProgressCallback,
): Promise<void> {
    const url = getOcenaudioDownloadUrl();
    const downloadsDir = path.join(BASE_DIR, 'downloads');
    let archivePath: string | undefined;

    try {
        // Ocenaudio extracts to a subdirectory named 'ocenaudio' so we extract to parent
        const parentDir = path.dirname(destDir);
        archivePath = await downloadFile(url, downloadsDir, 'ocenaudio.zip', onProgress);
        fs.mkdirSync(parentDir, { recursive: true });
        await extractArchive(archivePath, parentDir);
        console.log(`Ocenaudio installed successfully at: ${destDir}`);
    } finally {
        if (archivePath) cleanupArchive(archivePath);
    }
}

// ============================================================================
// Dispatcher
// ============================================================================

/**
 * Downloads a dependency by ID to the given destination path.
 */
export async function downloadDependency(
    depId: keyof DependenciesConfig,
    destPath: string,
    onProgress?: ProgressCallback,
): Promise<void> {
    switch (depId) {
        case 'uv':
            return downloadUv(destPath, onProgress);
        case 'obs':
            return downloadObs(destPath, onProgress);
        case 'ffmpeg':
            return downloadFfmpeg(destPath, onProgress);
        case 'oneocr':
            return downloadOneocr(destPath, onProgress);
        case 'ocenaudio':
            return downloadOcenaudio(destPath, onProgress);
        default:
            throw new Error(`Unknown dependency: ${depId}`);
    }
}

// ============================================================================
// System package detection (Linux)
// ============================================================================

export interface LinuxDistroInfo {
    id: string;        // e.g. "ubuntu", "fedora", "arch"
    name: string;      // e.g. "Ubuntu 24.04"
    packageManager: string; // e.g. "apt", "dnf", "pacman"
}

/**
 * Detect the Linux distribution by reading /etc/os-release.
 */
export function detectLinuxDistro(): LinuxDistroInfo {
    const fallback: LinuxDistroInfo = { id: 'unknown', name: 'Linux', packageManager: 'unknown' };

    try {
        const osReleasePath = '/etc/os-release';
        if (!fs.existsSync(osReleasePath)) return fallback;

        const content = fs.readFileSync(osReleasePath, 'utf-8');
        const getValue = (key: string): string => {
            const match = content.match(new RegExp(`^${key}=["']?(.+?)["']?$`, 'm'));
            return match ? match[1] : '';
        };

        const id = getValue('ID').toLowerCase();
        const idLike = getValue('ID_LIKE').toLowerCase();
        const prettyName = getValue('PRETTY_NAME') || getValue('NAME') || id;

        // Determine package manager from distro ID / ID_LIKE
        let packageManager = 'unknown';
        if (['ubuntu', 'debian', 'linuxmint', 'pop', 'elementary', 'zorin', 'kali', 'raspbian'].includes(id) || idLike.includes('debian') || idLike.includes('ubuntu')) {
            packageManager = 'apt';
        } else if (['fedora', 'rhel', 'centos', 'rocky', 'alma', 'nobara'].includes(id) || idLike.includes('fedora') || idLike.includes('rhel')) {
            packageManager = 'dnf';
        } else if (['opensuse', 'sles', 'opensuse-leap', 'opensuse-tumbleweed'].includes(id) || idLike.includes('suse')) {
            packageManager = 'zypper';
        } else if (['arch', 'manjaro', 'endeavouros', 'garuda', 'cachyos'].includes(id) || idLike.includes('arch')) {
            packageManager = 'pacman';
        } else if (['void'].includes(id)) {
            packageManager = 'xbps';
        } else if (['gentoo'].includes(id) || idLike.includes('gentoo')) {
            packageManager = 'emerge';
        } else if (['nixos'].includes(id)) {
            packageManager = 'nix';
        } else if (['alpine'].includes(id)) {
            packageManager = 'apk';
        }

        return { id, name: prettyName, packageManager };
    } catch {
        return fallback;
    }
}

/**
 * Get the install command for the portaudio library for a given package manager.
 */
export function getPortaudioInstallCommand(packageManager: string): string {
    switch (packageManager) {
        case 'apt':     return 'sudo apt install -y libportaudio2';
        case 'dnf':     return 'sudo dnf install -y portaudio';
        case 'zypper':  return 'sudo zypper install -y portaudio';
        case 'pacman':  return 'sudo pacman -S --noconfirm portaudio';
        case 'xbps':    return 'sudo xbps-install -y portaudio';
        case 'emerge':  return 'sudo emerge media-libs/portaudio';
        case 'nix':     return 'nix-env -iA nixpkgs.portaudio';
        case 'apk':     return 'sudo apk add portaudio';
        default:        return '# Install the portaudio / libportaudio2 package using your system package manager';
    }
}

/**
 * Check if a shared library is available on the system by running ldconfig -p.
 * Returns true if the library is loadable.
 */
export async function isSystemLibraryInstalled(libName: string): Promise<boolean> {
    try {
        const { stdout } = await execFilePromise('ldconfig', ['-p']);
        return stdout.toLowerCase().includes(libName.toLowerCase());
    } catch {
        // ldconfig may not be in PATH or may require root — try locating the .so directly
        try {
            const { stdout } = await execFilePromise('find', [
                '/usr/lib', '/usr/lib64', '/usr/local/lib',
                '-maxdepth', '2',
                '-name', `${libName}*`,
                '-type', 'f',
            ]);
            return stdout.trim().length > 0;
        } catch {
            return false;
        }
    }
}

// ============================================================================
// Write dependency_paths.json for Python side
// ============================================================================

/**
 * Writes a dependency_paths.json file to BASE_DIR so the Python backend can
 * read custom dependency locations.
 */
export function writeDependencyPathsJson(): void {
    const deps = getDependenciesConfig();
    const pathsObj: Record<string, string> = {};
    for (const [key, entry] of Object.entries(deps)) {
        if (entry.installed && entry.path) {
            pathsObj[key] = entry.path;
        }
    }
    const jsonPath = path.join(BASE_DIR, 'dependency_paths.json');
    fs.writeFileSync(jsonPath, JSON.stringify(pathsObj, null, 2), 'utf-8');
    console.log(`Wrote dependency_paths.json to ${jsonPath}`);
}
