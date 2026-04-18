export function getSourceControlActions(area) {
    switch (area) {
        case 'staged':
            return ['unstage'];
        case 'unstaged':
        case 'untracked':
            return ['discard', 'stage'];
        default:
            return [];
    }
}
