import { type CSSProperties, type ReactElement } from "react";
export interface PdfViewerLabels {
    /** Status shown while the PDF bytes and document are loading. */
    loading?: string;
    /** Error shown when the PDF cannot be fetched or opened. */
    loadError?: string;
    /** Error shown when the current page cannot be rendered. */
    pageError?: string;
    /** Label for the previous-page button. */
    previousPage?: string;
    /** Label for the next-page button. */
    nextPage?: string;
    /** Visible page-count text. */
    pageIndicator?: (pageNumber: number, totalPages: number) => string;
    /** Complete accessible name for the page-navigation controls. */
    navigationAriaLabel?: string;
    /** Complete accessible name for the rendered page. */
    pageAriaLabel?: (pageNumber: number, totalPages: number) => string;
}
export interface PdfViewerProps {
    /** A fetchable PDF URL, including a URL returned by `ctx.blobs.getUrl()`. */
    src: string;
    /** Accessible name used for the viewer and English default page labels. */
    ariaLabel?: string;
    /** User-visible and accessible labels. Omitted fields use English defaults. */
    labels?: PdfViewerLabels;
    /** Page shown after loading. Values outside the document are clamped. */
    initialPage?: number;
    className?: string;
    style?: CSSProperties;
}
/**
 * Render a PDF inside a generated Muse web artifact without navigating a
 * nested document to the raw blob URL.
 *
 * The source is fetched as bytes and handed to PDF.js. PDF evaluation is
 * disabled. PDF.js's worker logic is bundled into the SDK so generated clients
 * can use its main-thread fallback in both standard and confidential builds.
 */
export declare function PdfViewer({ src, ariaLabel, labels, initialPage, className, style, }: PdfViewerProps): ReactElement;
//# sourceMappingURL=pdf.d.ts.map