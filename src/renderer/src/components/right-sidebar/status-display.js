import { joinPath, normalizeRelativePath } from '@/lib/path';
import { splitPathSegments } from './path-tree';
export const STATUS_LABELS = {
    modified: 'M',
    added: 'A',
    deleted: 'D',
    renamed: 'R',
    untracked: 'U',
    copied: 'C'
};
export const STATUS_COLORS = {
    modified: 'var(--git-decoration-modified)',
    added: 'var(--git-decoration-added)',
    deleted: 'var(--git-decoration-deleted)',
    renamed: 'var(--git-decoration-renamed)',
    untracked: 'var(--git-decoration-untracked)',
    copied: 'var(--git-decoration-copied)'
};
const STATUS_PRIORITY = {
    deleted: 5,
    modified: 4,
    added: 3,
    untracked: 3,
    renamed: 2,
    copied: 1
};
export function getDominantStatus(statuses) {
    let dominantStatus = null;
    let dominantPriority = -1;
    for (const status of statuses) {
        const priority = STATUS_PRIORITY[status];
        if (priority > dominantPriority) {
            dominantStatus = status;
            dominantPriority = priority;
        }
    }
    return dominantStatus;
}
export function buildStatusMap(entries) {
    const statusByPath = new Map();
    for (const entry of entries) {
        const path = normalizeRelativePath(entry.path);
        const existing = statusByPath.get(path);
        const resolved = existing
            ? (getDominantStatus([existing, entry.status]) ?? entry.status)
            : entry.status;
        statusByPath.set(path, resolved);
    }
    return statusByPath;
}
export function buildFolderStatusMap(entries) {
    const folderStatuses = new Map();
    for (const entry of entries) {
        if (!shouldPropagateStatus(entry.status)) {
            continue;
        }
        const segments = splitPathSegments(entry.path);
        if (segments.length <= 1) {
            continue;
        }
        let currentPath = '';
        for (const segment of segments.slice(0, -1)) {
            currentPath = currentPath ? joinPath(currentPath, segment) : segment;
            const statuses = folderStatuses.get(currentPath);
            if (statuses) {
                statuses.push(entry.status);
            }
            else {
                folderStatuses.set(currentPath, [entry.status]);
            }
        }
    }
    return new Map(Array.from(folderStatuses.entries()).map(([folderPath, statuses]) => [
        folderPath,
        getDominantStatus(statuses)
    ]));
}
export function shouldPropagateStatus(status) {
    return status !== 'deleted';
}
