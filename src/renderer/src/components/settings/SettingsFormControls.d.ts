type ThemePickerProps = {
    label: string;
    description: string;
    selectedTheme: string;
    query: string;
    onQueryChange: (value: string) => void;
    onSelectTheme: (theme: string) => void;
};
type ColorFieldProps = {
    label: string;
    description: string;
    value: string;
    fallback: string;
    onChange: (value: string) => void;
};
type NumberFieldProps = {
    label: string;
    description: string;
    value: number;
    defaultValue?: number;
    min: number;
    max: number;
    step?: number;
    onChange: (value: number) => void;
    suffix?: string;
};
type FontAutocompleteProps = {
    value: string;
    suggestions: string[];
    onChange: (value: string) => void;
};
export declare function ThemePicker({ label, description, selectedTheme, query, onQueryChange, onSelectTheme }: ThemePickerProps): React.JSX.Element;
export declare function ColorField({ label, description, value, fallback, onChange }: ColorFieldProps): React.JSX.Element;
export declare function NumberField({ label, description, value, defaultValue, min, max, step, onChange, suffix }: NumberFieldProps): React.JSX.Element;
export declare function FontAutocomplete({ value, suggestions, onChange }: FontAutocompleteProps): React.JSX.Element;
export {};
