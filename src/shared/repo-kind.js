export function getRepoKind(repo) {
    return repo.kind === 'folder' ? 'folder' : 'git';
}
export function isFolderRepo(repo) {
    return getRepoKind(repo) === 'folder';
}
export function isGitRepoKind(repo) {
    return getRepoKind(repo) === 'git';
}
export function getRepoKindLabel(repo) {
    return isFolderRepo(repo) ? 'Folder' : 'Git';
}
