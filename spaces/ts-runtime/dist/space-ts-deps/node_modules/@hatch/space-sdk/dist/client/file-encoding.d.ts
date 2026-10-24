/**
 * Base64-encode raw bytes. Uses the engine's native
 * `Uint8Array.prototype.toBase64` when present; older engines fall back to
 * building the intermediate binary string in bounded 32 KB chunks (small
 * enough to never hit the call-argument limit, large enough that a phone
 * photo costs a few hundred calls instead of millions) and encoding once
 * with `btoa`. Safe for payloads of any size a Space realistically accepts.
 */
export declare function bytesToBase64(bytes: Uint8Array): string;
/**
 * Read a browser `File`/`Blob` (file input, drag-drop, camera capture) into
 * the `{ dataBase64, mimeType }` shape `ctx.inference.complete` accepts in
 * its `images` option. Pass the result through the action request; the
 * server hands it to inference (or `ctx.blobs`) without re-encoding.
 */
export declare function fileToBase64(file: Blob): Promise<{
    dataBase64: string;
    mimeType: string;
}>;
//# sourceMappingURL=file-encoding.d.ts.map