import { joinPath, normalizeRelativePath } from '@/lib/path';
import { splitPathSegments } from './path-tree';
export function normalizeAbsolutePath(path) {
    const normalizedPath = path.replace(/[\\/]+/g, '/');
    if (normalizedPath === '/') {
        return normalizedPath;
    }
    if (/^[A-Za-z]:\/$/.test(normalizedPath)) {
        return normalizedPath;
    }
    return normalizedPath.replace(/\/+$/, '');
}
export function isPathEqualOrDescendant(candidatePath, targetPath) {
    const normalizedCandidate = normalizeAbsolutePath(candidatePath);
    const normalizedTarget = normalizeAbsolutePath(targetPath);
    return (normalizedCandidate === normalizedTarget ||
        normalizedCandidate.startsWith(`${normalizedTarget}/`));
}
export function getRevealAncestorDirs(worktreePath, filePath) {
    const normalizedWorktreePath = normalizeAbsolutePath(worktreePath);
    const normalizedTargetPath = normalizeAbsolutePath(filePath);
    const prefix = `${normalizedWorktreePath}/`;
    if (normalizedTargetPath !== normalizedWorktreePath && !normalizedTargetPath.startsWith(prefix)) {
        return null;
    }
    const relativePath = normalizeRelativePath(normalizedTargetPath === normalizedWorktreePath ? '' : normalizedTargetPath.slice(prefix.length));
    const segments = splitPathSegments(relativePath);
    const ancestorDirs = [];
    let currentPath = worktreePath;
    for (const segment of segments.slice(0, -1)) {
        currentPath = joinPath(currentPath, segment);
        ancestorDirs.push(currentPath);
    }
    return ancestorDirs;
}
