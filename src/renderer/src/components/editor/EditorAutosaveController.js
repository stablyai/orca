import { useEffect } from 'react';
import { attachAppEditorAutosaveController } from './editor-autosave-controller';
export default function EditorAutosaveController() {
    useEffect(() => {
        // Why: autosave and quit coordination need to survive editor tab switches,
        // but keeping the full EditorPanel mounted while hidden widened the restart
        // surface too far. Keep only this narrow controller alive between mounts.
        return attachAppEditorAutosaveController();
    }, []);
    return null;
}
