/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
import { type ReactElement } from "react";
import { type IconAppearance, type IconAccessibility, type IconGlyph, type IconProps, type IconWeight } from "./types.js";
/** The SVG owns presentation only; its containing control owns interaction and its label. */
export declare function Icon(props: IconProps): ReactElement;
type Variants = Partial<{
    readonly [Weight in IconWeight]: IconGlyph<string, Weight>;
}>;
type WeightOf<Set> = Extract<keyof Set, IconWeight>;
/** Import only the weights this component needs; no all-weight registry is created. */
export declare function createIcon<Set extends Variants>(variants: Set, defaultWeight: WeightOf<Set>): (props: IconAppearance & IconAccessibility & {
    weight?: WeightOf<Set>;
}) => ReactElement;
export type { IconAccessibility, IconAppearance, IconGlyph, IconPath, IconProps, IconSize, IconWeight } from "./types.js";
//# sourceMappingURL=icon.d.ts.map