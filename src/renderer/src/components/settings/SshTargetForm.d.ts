export type EditingTarget = {
    label: string;
    configHost: string;
    host: string;
    port: string;
    username: string;
    identityFile: string;
    proxyCommand: string;
    jumpHost: string;
};
export declare const EMPTY_FORM: EditingTarget;
type SshTargetFormProps = {
    editingId: string | null;
    form: EditingTarget;
    onFormChange: (updater: (prev: EditingTarget) => EditingTarget) => void;
    onSave: () => void;
    onCancel: () => void;
};
export declare function SshTargetForm({ editingId, form, onFormChange, onSave, onCancel }: SshTargetFormProps): React.JSX.Element;
export {};
