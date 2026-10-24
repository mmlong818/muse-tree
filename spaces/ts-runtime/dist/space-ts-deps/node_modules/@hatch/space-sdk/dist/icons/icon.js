/** (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary. */
import { createElement } from "react";
import { iconLabel, iconSize } from "./types.js";
/** The SVG owns presentation only; its containing control owns interaction and its label. */
export function Icon(props) {
    const { glyph, color, className } = props;
    const size = iconSize(props.size);
    const label = iconLabel(props);
    return createElement("svg", {
        xmlns: "http://www.w3.org/2000/svg",
        viewBox: glyph.viewBox,
        width: size,
        height: size,
        fill: "none",
        focusable: "false",
        role: label == null ? undefined : "img",
        "aria-hidden": label == null ? true : undefined,
        "aria-label": label ?? undefined,
        className,
        style: color == null ? undefined : { color },
    }, glyph.paths.map((path, key) => createElement("path", { ...path, key })));
}
/** Import only the weights this component needs; no all-weight registry is created. */
export function createIcon(variants, defaultWeight) {
    const selected = new Map();
    let name;
    for (const [key, glyph] of Object.entries(variants)) {
        const weight = Number(key);
        if (glyph == null || ![300, 400, 500, 600, 700].includes(weight) ||
            glyph.weight !== weight || (name != null && glyph.name !== name)) {
            throw new Error("Icon weights must map to matching variants of one semantic icon");
        }
        name = glyph.name;
        selected.set(weight, glyph);
    }
    if (!selected.has(defaultWeight))
        throw new Error("Default icon weight is not selected");
    return function SelectedIcon(props) {
        const { weight = defaultWeight, ...appearance } = props;
        const glyph = selected.get(weight);
        if (glyph == null)
            throw new Error("Icon weight is not selected");
        return createElement(Icon, { ...appearance, glyph });
    };
}
