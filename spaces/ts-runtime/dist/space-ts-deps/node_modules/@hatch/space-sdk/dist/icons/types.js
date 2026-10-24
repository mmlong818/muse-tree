export function iconLabel(props) {
    if (props.decorative === true || props.label == null)
        return null;
    if (props.label.trim().length === 0)
        throw new Error("A meaningful icon needs a non-empty label");
    return props.label;
}
export function iconSize(size = 24) {
    if (![12, 16, 20, 24, 32, 40, 48].includes(size))
        throw new Error("Unsupported icon size");
    return size;
}
