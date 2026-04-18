import { type JSX } from 'react';
type ImageViewerProps = {
    content: string;
    filePath: string;
    mimeType?: string;
};
export default function ImageViewer({ content, filePath, mimeType }: ImageViewerProps): JSX.Element;
export {};
