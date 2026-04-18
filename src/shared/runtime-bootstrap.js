import { join } from 'path';
const PRIMARY_RUNTIME_METADATA_FILE = 'orca-runtime.json';
export function getRuntimeMetadataPath(userDataPath) {
    return join(userDataPath, PRIMARY_RUNTIME_METADATA_FILE);
}
