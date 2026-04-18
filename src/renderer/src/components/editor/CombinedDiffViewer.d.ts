import React from 'react';
import '@/lib/monaco-setup';
import type { OpenFile } from '@/store/slices/editor';
export default function CombinedDiffViewer({ file, viewStateKey }: {
    file: OpenFile;
    viewStateKey: string;
}): React.JSX.Element;
