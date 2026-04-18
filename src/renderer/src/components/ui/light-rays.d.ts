type LightRaysProps = {
    ref?: React.Ref<HTMLDivElement>;
    count?: number;
    color?: string;
    blur?: number;
    speed?: number;
    length?: string;
} & React.HTMLAttributes<HTMLDivElement>;
export declare function LightRays({ className, style, count, color, blur, speed, length, ref, ...props }: LightRaysProps): React.JSX.Element;
export {};
