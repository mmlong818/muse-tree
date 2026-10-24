import { z, type JsonValue } from "./server-contract";
export type ToolSearchVertical = "sports" | "weather" | "finance";
export interface ToolSearchLocation {
    readonly ip?: string;
    readonly lat?: number;
    readonly lon?: number;
    readonly timezone?: string;
}
/** Options common to every vertical helper. Date ranges use `since`/`until`. */
export interface ToolSearchOptions {
    /**
     * Inclusive ISO date lower bound, e.g. "2026-06-01". For `finance` history
     * this is the window start (`from`); when omitted it defaults to an
     * interval-based look-back.
     */
    readonly since?: string;
    /**
     * Inclusive ISO date upper bound, e.g. "2026-06-16". For `finance` history
     * this is the window end (`to`) and is applied client-side (defaults to
     * today); it is not plumbed into the backend request. See
     * `docs/vertical-tool-schemas.md`.
     */
    readonly until?: string;
    readonly language_code?: string;
    readonly location?: ToolSearchLocation;
    readonly timeout_secs?: number;
}
export interface ToolSearchResponse<TContent = JsonValue> {
    readonly content: TContent;
    readonly summary?: JsonValue;
    readonly metadata?: JsonValue;
    readonly search_engines?: readonly string[];
    readonly model?: string;
    readonly usage?: JsonValue;
}
/** Weather: current snapshot + a bounded forecast horizon. */
export interface ToolWeatherOptions extends ToolSearchOptions {
    /**
     * Select the maximum hourly forecast points to return, capped at 48. This is
     * applied client-side to the upstream hourly series. Omit to preserve the
     * existing maximum of 48 points when hourly data is available.
     */
    readonly hourly_hours?: number;
}
/**
 * Sampling granularity for `finance` history; selects which candle set the
 * builder maps into `instruments[].history`.
 */
export type ToolFinanceInterval = "1m" | "30m" | "1d" | "1w" | "1mo";
/**
 * Finance: latest quote + an optional historical OHLCV series.
 *
 * The history window is the inherited `since`/`until` (from/to, inclusive ISO
 * dates), applied client-side to the candle set the backend returns. `until`
 * defaults to today; `since` defaults to an interval-based look-back
 * (1m ≈ 1 day, 30m ≈ 1 week, 1d ≈ 3 months, 1w ≈ 1 year,
 * 1mo ≈ 5 years). Choose `1m` for a current-session chart; `30m` is an
 * independently populated coarser series and is intended for multi-day views.
 */
export interface ToolFinanceOptions extends ToolSearchOptions {
    /** Sampling granularity for the history series. Omit for latest quote only. */
    readonly interval?: ToolFinanceInterval;
}
export declare const TOOL_WEATHER_RESULT_SCHEMA: z.ZodObject<{
    location: z.ZodString;
    summary: z.ZodString;
    conditions: z.ZodObject<{
        temperature: z.ZodNullable<z.ZodNumber>;
        unit: z.ZodString;
        description: z.ZodString;
        feels_like: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        high: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        low: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        humidity_percent: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        precipitation_chance: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        precipitation_amount: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        wind: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        uv_index: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        uv_description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        air_quality_index: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        air_quality_description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        sunrise: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        sunset: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>;
    forecast_days: z.ZodArray<z.ZodObject<{
        date: z.ZodNullable<z.ZodString>;
        summary: z.ZodNullable<z.ZodString>;
        current: z.ZodNullable<z.ZodNumber>;
        high: z.ZodNullable<z.ZodNumber>;
        low: z.ZodNullable<z.ZodNumber>;
        precipitation_chance: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        precipitation_amount: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        wind: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>>;
    forecast_hourly: z.ZodOptional<z.ZodArray<z.ZodObject<{
        time: z.ZodNullable<z.ZodString>;
        temperature: z.ZodNullable<z.ZodNumber>;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        precipitation_chance: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        precipitation_amount: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        wind: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>>>;
    alerts: z.ZodOptional<z.ZodArray<z.ZodString>>;
    sources: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        url: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ToolWeatherResult = z.infer<typeof TOOL_WEATHER_RESULT_SCHEMA>;
export declare const TOOL_SPORTS_DATA_RESULT_SCHEMA: z.ZodObject<{
    summary: z.ZodString;
    items: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        summary: z.ZodString;
        url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        sport: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        league: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        season: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            label: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            year: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            type: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            name: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            start_date: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            end_date: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        }, z.core.$strip>>>;
        teams: z.ZodOptional<z.ZodArray<z.ZodString>>;
        home: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        away: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        score: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        status: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        starts_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        player_statistics: z.ZodOptional<z.ZodArray<z.ZodObject<{
            player: z.ZodString;
            team: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            position: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            stats: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
        }, z.core.$strip>>>;
        team_statistics: z.ZodOptional<z.ZodArray<z.ZodObject<{
            team: z.ZodString;
            qualifier: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            stats: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    sources: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        url: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ToolSportsDataResult = z.infer<typeof TOOL_SPORTS_DATA_RESULT_SCHEMA>;
export declare const TOOL_FINANCE_RESULT_SCHEMA: z.ZodObject<{
    summary: z.ZodString;
    instruments: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        symbol: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        summary: z.ZodString;
        price: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        currency: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        change: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        change_percent: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        high: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        low: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        week_52_high: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        week_52_low: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        beta: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        market_cap: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        market_status: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        as_of: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        history: z.ZodOptional<z.ZodObject<{
            since: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            until: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            interval: z.ZodString;
            points: z.ZodArray<z.ZodObject<{
                date: z.ZodNullable<z.ZodString>;
                close: z.ZodNullable<z.ZodNumber>;
                open: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
                high: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
                low: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
                volume: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    sources: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        url: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ToolFinanceResult = z.infer<typeof TOOL_FINANCE_RESULT_SCHEMA>;
/**
 * Single-ticker finance result: exactly one resolved instrument (not an array).
 *
 * `finance_ticker` takes ONE ticker symbol and resolves the upstream matches
 * down to a single instrument — dropping the leveraged-ETF / foreign-listing
 * noise a bare symbol otherwise pulls in. `resolved.matched` reports how it
 * resolved; `instrument` is null only when nothing matched.
 */
export declare const TOOL_FINANCE_TICKER_RESULT_SCHEMA: z.ZodObject<{
    resolved: z.ZodObject<{
        symbol: z.ZodString;
        matched: z.ZodEnum<{
            exact: "exact";
            best: "best";
            none: "none";
        }>;
    }, z.core.$strip>;
    instrument: z.ZodNullable<z.ZodObject<{
        name: z.ZodString;
        symbol: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        summary: z.ZodString;
        price: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        currency: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        change: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        change_percent: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        high: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        low: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        week_52_high: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        week_52_low: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        beta: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        market_cap: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        market_status: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        as_of: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        history: z.ZodOptional<z.ZodObject<{
            since: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            until: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            interval: z.ZodString;
            points: z.ZodArray<z.ZodObject<{
                date: z.ZodNullable<z.ZodString>;
                close: z.ZodNullable<z.ZodNumber>;
                open: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
                high: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
                low: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
                volume: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    sources: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        url: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ToolFinanceTickerResult = z.infer<typeof TOOL_FINANCE_TICKER_RESULT_SCHEMA>;
export declare const TOOL_WEB_SEARCH_RESULT_SCHEMA: z.ZodObject<{
    summary: z.ZodString;
    vertical: z.ZodString;
    results: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        url: z.ZodNullable<z.ZodString>;
        source: z.ZodNullable<z.ZodString>;
        snippet: z.ZodNullable<z.ZodString>;
        published_at: z.ZodNullable<z.ZodString>;
        last_updated_raw: z.ZodNullable<z.ZodString>;
        favicon_url: z.ZodNullable<z.ZodString>;
        rank: z.ZodNumber;
        is_index_page: z.ZodBoolean;
    }, z.core.$strip>>;
    sources: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        url: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ToolWebSearchResult = z.infer<typeof TOOL_WEB_SEARCH_RESULT_SCHEMA>;
export declare const TOOL_WEATHER_SCHEMA: JsonValue;
export declare const TOOL_SPORTS_DATA_SCHEMA: JsonValue;
export declare const TOOL_FINANCE_SCHEMA: JsonValue;
export declare const TOOL_FINANCE_TICKER_SCHEMA: JsonValue;
export declare const TOOL_WEB_SEARCH_SCHEMA: JsonValue;
/** Orientation for {@link SpaceToolClient.generate_media}. */
export type GenerateMediaOrientation = "square" | "landscape" | "portrait";
/** Options for {@link SpaceToolClient.generate_media}. */
export interface GenerateMediaOptions {
    /** Image aspect orientation. Defaults to `"square"`. */
    readonly orientation?: GenerateMediaOrientation;
    /** Optional override key under which to store the blob (default: a generated key). */
    readonly key?: string;
}
/**
 * A generated image, already stored in THIS Space's `ctx.blobs`. `url` is an
 * own-origin, stable, no-expiry, document-relative URL (`./blobs/<key>`) —
 * render it directly and persist `blobKey` (never a foreign URL).
 */
export interface GeneratedMedia {
    readonly blobKey: string;
    readonly url: string;
    readonly contentType: string;
    readonly bytes: number;
}
export interface SpaceToolClient {
    /** Weather-shaped current conditions + forecast horizon via Muse's managed weather vertical. */
    weather(query: string, options?: ToolWeatherOptions): Promise<ToolSearchResponse<ToolWeatherResult>>;
    /** Sports scores/schedules/results via Muse's managed sports vertical. */
    sports_data(query: string, options?: ToolSearchOptions): Promise<ToolSearchResponse<ToolSportsDataResult>>;
    /**
     * @deprecated Don't reach for `finance`. Use
     * {@link SpaceToolClient.finance_ticker} for a single ticker's quote / price /
     * history (by symbol), and {@link SpaceToolClient.web_search} for everything
     * else — including resolving a company name to a ticker (search the name, read
     * the symbol out of the results, then call `finance_ticker`), comparing
     * several instruments, and analytical questions (earnings, analyst views, why
     * a stock moved). The method stays available so existing artifacts keep
     * working, but it is being removed from the guidance and will be deleted.
     *
     * Finance search via Muse's managed finance vertical: a free-text query
     * returns an array of matched instruments (latest quote + optional OHLCV
     * history each). For a single ticker symbol, see
     * {@link SpaceToolClient.finance_ticker}.
     */
    finance(query: string, options?: ToolFinanceOptions): Promise<ToolSearchResponse<ToolFinanceResult>>;
    /**
     * Single-ticker quote (+ optional OHLCV history) via Muse's managed finance
     * vertical. Takes one ticker symbol, e.g. `"AAPL"`; the result is one
     * resolved `instrument` (not an array) plus `resolved.matched`
     * (`"exact"` | `"best"` | `"none"`) — the exact symbol match when present,
     * otherwise the top-ranked result, with the other matched instruments (ETFs,
     * cross-listings) omitted. For several tickers, call once per ticker (e.g.
     * with `Promise.all`); a multi-token string (`"META GOOG"`) is rejected. To go
     * from a company name to a symbol, or to compare several instruments, use
     * {@link SpaceToolClient.web_search} (then call this with the resolved symbol).
     */
    finance_ticker(symbol: string, options?: ToolFinanceOptions): Promise<ToolSearchResponse<ToolFinanceTickerResult>>;
    /**
     * A general **web search**, run in the action — the same search the agent's
     * browser_search runs by default (no vertical filter). Use it for any topic
     * the structured vertical tools don't cover: analysis, "why", world
     * knowledge, comparisons, how-tos (e.g. "how does a heat pump work", "best
     * espresso machines 2026"). Returns a typed list of `results` ({@link ToolWebSearchResult});
     * each `snippet` is a substantial excerpt — usually enough to summarize via
     * `ctx.inference.complete` without opening the page; dates are best-effort.
     * For a stock quote / price / history use {@link SpaceToolClient.finance_ticker};
     * for scores/schedules/stats use
     * {@link SpaceToolClient.sports_data}. Don't spawn an artifact task just to search
     * — it runs this same search; reserve a task for opening/reading full pages,
     * multi-step research, or other agent tools.
     */
    web_search(query: string, options?: ToolSearchOptions): Promise<ToolSearchResponse<ToolWebSearchResult>>;
    /**
     * Generate an image server-side and store it in this Space's `ctx.blobs`,
     * returning a durable own-origin URL + blob key. No network egress from the
     * action and no expiring URL — prefer this for hero/per-item imagery, and as
     * the fallback when a web photo can't be sourced. Persist `blobKey` in your
     * DB and render `url`.
     */
    generate_media(prompt: string, options?: GenerateMediaOptions): Promise<GeneratedMedia>;
}
//# sourceMappingURL=verticals.d.ts.map