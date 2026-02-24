/**
 * Shared download and extraction utilities.
 * Used by both python_downloader and dependency_downloader.
 */

import * as path from 'path';
import * as fs from 'fs';
import { Downloader } from 'nodejs-file-downloader';
import * as tar from 'tar';
import extract from 'extract-zip';
import { BrowserWindow } from 'electron';

// ============================================================================
// Types
// ============================================================================

export interface DownloadProgress {
    /** Percentage as 0-100 */
    percentage: number;
    /** Bytes downloaded so far */
    downloaded: number;
    /** Total bytes (if known) */
    total: number | null;
}

export type ProgressCallback = (progress: DownloadProgress) => void;

// ============================================================================
// Download
// ============================================================================

/**
 * Downloads a file from a URL to a specified directory, with optional progress reporting.
 * @param url - The URL of the file to download.
 * @param directory - The destination directory.
 * @param fileName - The name to save the file as.
 * @param onProgress - Optional callback for download progress updates.
 * @returns The full path to the downloaded file.
 */
export async function downloadFile(
    url: string,
    directory: string,
    fileName: string,
    onProgress?: ProgressCallback,
): Promise<string> {
    console.log(`Downloading from ${url}...`);

    fs.mkdirSync(directory, { recursive: true });

    const downloader = new Downloader({
        url,
        directory,
        fileName,
        cloneFiles: false,
        onProgress: (percentage: string, _chunk: any, remainingSize: number) => {
            if (onProgress) {
                const pct = parseFloat(percentage) || 0;
                // remainingSize is bytes remaining; totalSize = downloaded + remaining
                // We can compute downloaded = total - remaining  if totalSize is known
                // nodejs-file-downloader passes percentage as string
                onProgress({
                    percentage: Math.round(pct),
                    downloaded: 0, // We'll calculate properly below
                    total: null,
                });
            }
        },
    });

    const finalFilePath = path.join(directory, fileName);

    try {
        const { filePath, downloadStatus } = await downloader.download();
        if (downloadStatus !== 'COMPLETE' || !filePath) {
            throw new Error(`Download status was ${downloadStatus}.`);
        }
        console.log(`Download complete: ${filePath}`);
        if (onProgress) {
            onProgress({ percentage: 100, downloaded: 0, total: null });
        }
        return filePath;
    } catch (error: any) {
        if (error.code === 'ENOENT' && fs.existsSync(finalFilePath)) {
            console.warn(
                `Download appears successful, but a non-critical cleanup error occurred. Ignoring. Details: ${error.message}`,
            );
            return finalFilePath;
        }
        console.error(`Failed to download file from ${url}: ${error.message || error}`);
        throw error;
    }
}

// ============================================================================
// Extraction
// ============================================================================

/**
 * Extracts a .tar.gz or .zip archive to a specified path.
 * @param archivePath - The full path to the archive file.
 * @param extractPath - The directory to extract the contents into.
 */
export async function extractArchive(archivePath: string, extractPath: string): Promise<void> {
    console.log(`Extracting ${archivePath} to ${extractPath}...`);

    fs.mkdirSync(extractPath, { recursive: true });

    try {
        if (archivePath.endsWith('.zip')) {
            await extract(archivePath, { dir: path.resolve(extractPath) });
        } else {
            // Extract tar.gz file
            await tar.x({
                file: archivePath,
                cwd: extractPath,
            });
        }
        console.log('Extraction complete.');
    } catch (error: any) {
        console.error(`Extraction failed: ${error.message || error}`);
        throw error;
    }
}

// ============================================================================
// Flatten Directory
// ============================================================================

/**
 * Flatten directory structure — moves all files from subdirectories up to root dir.
 * Used by FFmpeg extraction.
 */
export function flattenDirectory(directory: string): void {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const subDir = path.join(directory, entry.name);
            flattenDirectoryRecursive(subDir, directory);
            // Remove the now-empty subdirectory
            try {
                fs.rmSync(subDir, { recursive: true, force: true });
            } catch {
                // ignore
            }
        }
    }
}

function flattenDirectoryRecursive(sourceDir: string, targetDir: string): void {
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);
        if (entry.isDirectory()) {
            flattenDirectoryRecursive(sourcePath, targetDir);
        } else {
            if (!fs.existsSync(targetPath)) {
                fs.renameSync(sourcePath, targetPath);
            }
        }
    }
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Safely remove a downloaded archive file.
 */
export function cleanupArchive(archivePath: string): void {
    if (archivePath && fs.existsSync(archivePath)) {
        console.log(`Cleaning up downloaded archive: ${archivePath}`);
        fs.unlinkSync(archivePath);
    }
}

// ============================================================================
// IPC Progress Helper
// ============================================================================

/**
 * Sends download progress to a BrowserWindow via IPC.
 */
export function sendProgressToWindow(
    win: BrowserWindow | null,
    depId: string,
    progress: DownloadProgress,
): void {
    if (win && !win.isDestroyed()) {
        win.webContents.send('setup.progress', { depId, ...progress });
    }
}
