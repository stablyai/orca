import { type LucideIcon, type LucideProps } from 'lucide-react';
type NavSection = {
    id: string;
    title: string;
    icon: LucideIcon | ((props: LucideProps) => React.JSX.Element);
    badge?: string;
};
type RepoNavSection = NavSection & {
    badgeColor?: string;
    isRemote?: boolean;
};
type SettingsSidebarProps = {
    activeSectionId: string;
    generalSections: NavSection[];
    repoSections: RepoNavSection[];
    hasRepos: boolean;
    searchQuery: string;
    onBack: () => void;
    onSearchChange: (query: string) => void;
    onSelectSection: (sectionId: string) => void;
};
export declare function SettingsSidebar({ activeSectionId, generalSections, repoSections, hasRepos, searchQuery, onBack, onSearchChange, onSelectSection }: SettingsSidebarProps): React.JSX.Element;
export {};
