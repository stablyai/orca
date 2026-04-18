import React from 'react';
import type { Repo } from '../../../../shared/types';
type RepoComboboxProps = {
    repos: Repo[];
    value: string;
    onValueChange: (repoId: string) => void;
    placeholder?: string;
    triggerClassName?: string;
};
export default function RepoCombobox({ repos, value, onValueChange, placeholder, triggerClassName }: RepoComboboxProps): React.JSX.Element;
export {};
