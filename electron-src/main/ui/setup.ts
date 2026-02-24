/**
 * Setup window IPC handlers.
 *
 * Provides the renderer (setup.html) with methods to:
 *   - List dependencies and their status
 *   - Browse for directory
 *   - Check if a dep exists at a given path
 *   - Detect dep in system PATH
 *   - Trigger downloads with progress
 *   - Save chosen paths
 *   - Signal setup completion
 */

import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
    DependenciesConfig,
    DependencyEntry,
    getDependenciesConfig,
    getDependencyEntry,
    setDependencyEntry,
    setHasCompletedSetup,
} from '../store.js';
import {
    getDependencyMetas,
    isDependencyInstalledAt,
    findInSystemPath,
    downloadDependency,
    writeDependencyPathsJson,
    detectLinuxDistro,
    getPortaudioInstallCommand,
    isSystemLibraryInstalled,
    type DependencyMeta,
} from '../downloader/dependency_downloader.js';
import { BASE_DIR } from '../util.js';
import * as path from 'path';
import { sendProgressToWindow } from '../downloader/utils.js';

/** The setup window BrowserWindow reference — set by createSetupWindow() */
let setupWindow: BrowserWindow | null = null;

export function setSetupWindow(win: BrowserWindow | null): void {
    setupWindow = win;
}

// ============================================================================
// Build full dep status for the renderer
// ============================================================================

export interface DependencyStatus {
    id: string;
    name: string;
    description: string;
    path: string;
    installed: boolean;
    source: string;
    downloadUrl: string;
    diskSize: string;
    required: boolean;
    systemPath: string | null;
    /** True for system-level packages (installed via OS package manager, not downloadable) */
    systemPackage: boolean;
}

async function buildDependencyStatuses(): Promise<DependencyStatus[]> {
    const metas = getDependencyMetas();
    const storedDeps = getDependenciesConfig();
    const statuses: DependencyStatus[] = [];

    for (const meta of metas) {
        const stored = storedDeps[meta.id];
        const isSystemPkg = !!meta.systemPackage;

        if (isSystemPkg) {
            // System package: check if the library is loadable on the system
            const libInstalled = await isSystemLibraryInstalled('libportaudio');
            if (libInstalled) {
                // Mark as installed in store
                setDependencyEntry(meta.id, { path: '', installed: true, source: 'detected' });
            }
            statuses.push({
                id: meta.id,
                name: meta.name,
                description: meta.description,
                path: '',
                installed: libInstalled,
                source: libInstalled ? 'detected' : 'none',
                downloadUrl: '',
                diskSize: meta.diskSize,
                required: meta.required,
                systemPath: null,
                systemPackage: true,
            });
            continue;
        }

        const effectivePath = stored.path || meta.defaultPath;

        // Check if installed at stored/default path
        const installed = stored.installed && isDependencyInstalledAt(meta, effectivePath);

        // Try to find in system PATH
        let systemPath: string | null = null;
        if (meta.systemBinary && !installed) {
            systemPath = await findInSystemPath(meta.systemBinary);
        }

        let downloadUrl = '';
        try {
            downloadUrl = await meta.getDownloadUrl();
        } catch { /* dynamic URL may fail until needed */ }

        statuses.push({
            id: meta.id,
            name: meta.name,
            description: meta.description,
            path: effectivePath,
            installed: installed || (systemPath !== null && isDependencyInstalledAt(meta, systemPath)),
            source: installed ? stored.source : (systemPath ? 'detected' : 'none'),
            downloadUrl,
            diskSize: meta.diskSize,
            required: meta.required,
            systemPath,
            systemPackage: false,
        });
    }

    return statuses;
}

// ============================================================================
// Register IPC Handlers
// ============================================================================

export function registerSetupIPC(): void {
    // Return all dependency statuses
    ipcMain.handle('setup.getDeps', async () => {
        return buildDependencyStatuses();
    });

    // Open native directory picker
    ipcMain.handle('setup.browse', async (_, depId: string) => {
        const result = await dialog.showOpenDialog(setupWindow || BrowserWindow.getFocusedWindow()!, {
            properties: ['openDirectory'],
            title: `Select directory for ${depId}`,
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    });

    // Check if a dependency is installed at a given path
    ipcMain.handle('setup.checkPath', async (_, depId: string, depPath: string) => {
        const metas = getDependencyMetas();
        const meta = metas.find((m) => m.id === depId);
        if (!meta) return false;
        return isDependencyInstalledAt(meta, depPath);
    });

    // Detect dependency in system PATH
    ipcMain.handle('setup.detectSystem', async (_, depId: string) => {
        const metas = getDependencyMetas();
        const meta = metas.find((m) => m.id === depId);
        if (!meta || !meta.systemBinary) return null;
        return findInSystemPath(meta.systemBinary);
    });

    // Save a dependency path (without download)
    ipcMain.handle('setup.savePath', async (_, depId: string, depPath: string, source: string) => {
        const id = depId as keyof DependenciesConfig;
        const metas = getDependencyMetas();
        const meta = metas.find((m) => m.id === depId);
        const installed = meta ? isDependencyInstalledAt(meta, depPath) : false;
        setDependencyEntry(id, {
            path: depPath,
            installed,
            source: (source || 'manual') as any,
        });
        return { installed };
    });

    // Trigger download of a dependency
    ipcMain.handle('setup.download', async (_, depId: string, destPath: string) => {
        const id = depId as keyof DependenciesConfig;

        try {
            await downloadDependency(id, destPath, (progress) => {
                sendProgressToWindow(setupWindow, depId, progress);
            });

            // Mark as installed in store
            setDependencyEntry(id, {
                path: destPath,
                installed: true,
                source: 'downloaded',
            });

            return { success: true };
        } catch (error: any) {
            console.error(`Failed to download ${depId}:`, error);
            return { success: false, error: error.message || String(error) };
        }
    });

    // Get download URL + size for confirmation dialog
    ipcMain.handle('setup.getDownloadInfo', async (_, depId: string) => {
        const metas = getDependencyMetas();
        const meta = metas.find((m) => m.id === depId);
        if (!meta) return null;

        let downloadUrl = '';
        try {
            downloadUrl = await meta.getDownloadUrl();
        } catch (e: any) {
            downloadUrl = `(Could not resolve: ${e.message})`;
        }

        return {
            url: downloadUrl,
            diskSize: meta.diskSize,
        };
    });

    // Get distro info and install command for a system package
    ipcMain.handle('setup.getSystemPackageInfo', async (_, depId: string) => {
        const distro = detectLinuxDistro();
        const installCommand = depId === 'portaudio'
            ? getPortaudioInstallCommand(distro.packageManager)
            : `# Install ${depId} using your system package manager`;
        return {
            distroName: distro.name,
            distroId: distro.id,
            packageManager: distro.packageManager,
            installCommand,
        };
    });

    // Re-check whether a system library is installed (after user manually installs)
    ipcMain.handle('setup.checkSystemLib', async (_, depId: string) => {
        if (depId === 'portaudio') {
            const installed = await isSystemLibraryInstalled('libportaudio');
            if (installed) {
                setDependencyEntry('portaudio', { path: '', installed: true, source: 'detected' });
            }
            return { installed };
        }
        return { installed: false };
    });

    // Get the current venv path (stored under dependencies.python.path)
    ipcMain.handle('setup.getVenvPath', async () => {
        const entry = getDependencyEntry('python');
        return entry.path || path.join(BASE_DIR, 'python_venv');
    });

    // Save venv location (browse for directory)
    ipcMain.handle('setup.browseVenv', async () => {
        const result = await dialog.showOpenDialog(setupWindow || BrowserWindow.getFocusedWindow()!, {
            properties: ['openDirectory', 'createDirectory'],
            title: 'Choose location for Python virtual environment',
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    });

    // Persist the chosen venv path
    ipcMain.handle('setup.saveVenvPath', async (_, venvPath: string) => {
        setDependencyEntry('python', {
            path: venvPath,
            installed: false,
            source: 'manual',
        });
        return { success: true };
    });

    // Signal that setup is complete
    ipcMain.handle('setup.complete', async () => {
        setHasCompletedSetup(true);
        writeDependencyPathsJson();
        return { success: true };
    });
}
