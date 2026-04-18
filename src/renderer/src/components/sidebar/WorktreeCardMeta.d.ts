/**
 * Issue, PR, and Comment meta sections for WorktreeCard.
 *
 * Why extracted: keeps WorktreeCard.tsx under the 400-line oxlint limit
 * while co-locating the HoverCard presentation for each metadata type.
 */
import React from 'react';
import type { PRInfo, IssueInfo } from '../../../../shared/types';
type IssueSectionProps = {
    issue: IssueInfo;
    onClick: (e: React.MouseEvent) => void;
};
export declare function IssueSection({ issue, onClick }: IssueSectionProps): React.JSX.Element;
type PrSectionProps = {
    pr: PRInfo;
    onClick: (e: React.MouseEvent) => void;
};
export declare function PrSection({ pr, onClick }: PrSectionProps): React.JSX.Element;
type CommentSectionProps = {
    comment: string;
    onDoubleClick: (e: React.MouseEvent) => void;
};
export declare function CommentSection({ comment, onDoubleClick }: CommentSectionProps): React.JSX.Element;
export {};
