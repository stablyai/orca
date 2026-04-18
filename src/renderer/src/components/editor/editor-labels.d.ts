import type { OpenFile } from '@/store/slices/editor';
type EditorLabelVariant = 'fileName' | 'relativePath' | 'fullPath';
export declare function getEditorDisplayLabel(file: OpenFile, variant?: EditorLabelVariant): string;
export {};
