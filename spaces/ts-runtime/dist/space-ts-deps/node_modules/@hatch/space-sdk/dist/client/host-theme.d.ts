export declare const SPACE_THEME_MESSAGE_TYPE = "hatch:space:theme";
declare const COLOR_SCHEMES: readonly ["light", "dark"];
declare const ACCENT_COLORS: readonly ["blue", "green", "red", "purple", "pink", "orange", "monochrome"];
export type SpaceColorScheme = (typeof COLOR_SCHEMES)[number];
export type SpaceAccentColor = (typeof ACCENT_COLORS)[number];
export interface SpaceTheme {
    colorScheme: SpaceColorScheme;
    accentColor: SpaceAccentColor;
}
export declare function parseSpaceThemeMessage(data: unknown): SpaceTheme | null;
export declare function applySpaceTheme(theme: SpaceTheme, root: HTMLElement): void;
export declare function installSpaceThemeListener(): void;
export {};
//# sourceMappingURL=host-theme.d.ts.map