export declare function extractIpcErrorMessage(err: unknown, fallback: string): string;
export declare function getImageCopyDestination(markdownFilePath: string, sourceImagePath: string): Promise<{
    imageName: string;
    destPath: string;
}>;
