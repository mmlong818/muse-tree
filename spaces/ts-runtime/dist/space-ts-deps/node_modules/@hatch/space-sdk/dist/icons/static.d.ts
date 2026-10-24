/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
import { type IconAccessibility, type IconAppearance, type IconGlyph } from "./types.js";
/** Materialize a selected glyph as inline markup; no React, script, image or font loader. */
export declare function renderIconSvg(props: Omit<IconAppearance, "color"> & IconAccessibility & {
    glyph: IconGlyph;
}): string;
export type { IconGlyph, IconPath, IconProps, IconSize, IconWeight } from "./types.js";
//# sourceMappingURL=static.d.ts.map