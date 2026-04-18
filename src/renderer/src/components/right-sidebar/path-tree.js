export function splitPathSegments(path) {
    return path.split(/[\\/]+/).filter(Boolean);
}
