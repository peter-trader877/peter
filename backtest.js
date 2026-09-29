/* ============================================================
   MARKET DRIVERS AI BACKTESTER
   Version: 4.0.0-INTRADAY-CLEAN
   ============================================================

   PURPOSE
   -------
   - Uses the SAME AIEngine used by the live dashboard.
   - Does NOT create separate strategy rules.
   - Historical candles generate the signal.
   - Future candles ONLY determine WIN / LOSS / EXPIRED / OPEN.
   - 5m default holding window = 36 candles = 3 hours.
   - Prevents overlapping A+ trades.
   - Does not artificially improve win rate.
   - Does not change AI A+ thresholds.

   OUTCOMES
   --------
   WIN     = target reached before stop
   LOSS    = stop reached before target
   EXPIRED = neither target nor stop reached within horizon
   OPEN    = historical data ended before horizon completed

   ============================================================ */

"use strict";

/* ============================================================
   CONFIGURATION
   ============================================================ */

const API_BASE = "https://biquote.io/api";

const DEFAULT_MARKET = "XAUUSD";
const DEFAULT_TIMEFRAME = "5m";

const DEFAULT_CANDLES = 1000;
const DEFAULT_WARMUP = 80;

/*
   36 x 5-minute candles = 180 minutes = 3 hours.

   The HTML control can override this value.
*/
const DEFAULT_FORWARD_BARS = 36;

const MAX_API_LIMIT = 1000;
const API_ATTEMPTS = 3;

const ENGINE_NAME = "3.3.0-high-confluence";

const A_PLUS_SCORE = 82;
const A_PLUS_CONFIRMATIONS = 4;
const A_PLUS_RR = 1.25;

const DEBUG = true;


/* ============================================================
   STATE
   ============================================================ */

const state = {
    market: DEFAULT_MARKET,
    timeframe: DEFAULT_TIMEFRAME,

    candles: DEFAULT_CANDLES,
    warmup: DEFAULT_WARMUP,
    forwardBars: DEFAULT_FORWARD_BARS,

    historicalBars: [],

    trades: [],
    decisions: [],

    running: false,
    stopRequested: false,

    startTime: null,
    endTime: null,

    stats: {
        total: 0,
        wins: 0,
        losses: 0,
        expired: 0,
        open: 0,
        netR: 0,
        profitFactor: 0,
        maxDD: 0,
        winRate: 0
    },

    consistency: {
        decisions: 0,
        aPlus: 0,
        wait: 0,
        leakage: 0,
        errors: 0
    }
};


/* ============================================================
   DOM HELPERS
   ============================================================ */

function $(id) {
    return document.getElementById(id);
}


function setText(id, value) {
    const el = $(id);

    if (el) {
        el.textContent = value;
    }
}


function log(message, type = "info") {
    const text = `[${new Date().toLocaleTimeString()}] ${message}`;

    console.log(text);

    const consoleEl = $("console");

    if (!consoleEl) {
        return;
    }

    const row = document.createElement("div");

    row.className = `log-${type}`;

    row.textContent = text;

    consoleEl.appendChild(row);

    consoleEl.scrollTop = consoleEl.scrollHeight;
}


function clearConsole() {
    const consoleEl = $("console");

    if (consoleEl) {
        consoleEl.innerHTML = "";
    }
}


function setStatus(message) {
    setText("status", message);
}


function setProgress(percent, message = null) {
    const safe = Math.max(0, Math.min(100, Number(percent) || 0));

    const progressBar = $("progressBar");
    const progress = $("progress");

    if (progressBar) {
        progressBar.style.width = `${safe}%`;
    }

    if (progress) {
        progress.textContent =
            message !== null
                ? message
                : `${Math.round(safe)}%`;
    }
}


/* ============================================================
   AI ENGINE CHECK
   ============================================================ */

function getAIEngine() {
    if (!window.AIEngine) {
        throw new Error(
            "AIEngine is not available. Make sure ai-engine.js loads before backtest.js."
        );
    }

    return window.AIEngine;
}


function getEngineName() {
    try {
        const engine = getAIEngine();

        return (
            engine.VERSION ||
            engine.version ||
            engine.ENGINE_VERSION ||
            ENGINE_NAME
        );
    } catch (error) {
        return ENGINE_NAME;
    }
}


/* ============================================================
   TIMEFRAME HELPERS
   ============================================================ */

function timeframeMinutes(timeframe) {
    switch (timeframe) {
        case "1m":
            return 1;

        case "5m":
            return 5;

        case "15m":
            return 15;

        case "30m":
            return 30;

        case "1h":
            return 60;

        case "4h":
            return 240;

        case "1d":
            return 1440;

        default:
            return 5;
    }
}


function timeframeMilliseconds(timeframe) {
    return timeframeMinutes(timeframe) * 60 * 1000;
}


function formatDurationBars(bars, timeframe) {
    const minutes = Number(bars) * timeframeMinutes(timeframe);

    if (minutes < 60) {
        return `${minutes} minutes`;
    }

    const hours = minutes / 60;

    if (hours < 24) {
        return `${hours} hour${hours === 1 ? "" : "s"}`;
    }

    const days = hours / 24;

    return `${days.toFixed(1)} days`;
}


/* ============================================================
   NUMBER HELPERS
   ============================================================ */

function num(value, fallback = NaN) {
    const n = Number(value);

    return Number.isFinite(n) ? n : fallback;
}


function round(value, decimals = 2) {
    const n = Number(value);

    if (!Number.isFinite(n)) {
        return 0;
    }

    const factor = Math.pow(10, decimals);

    return Math.round(n * factor) / factor;
}


/* ============================================================
   DATE HELPERS
   ============================================================ */

function toDate(value) {
    if (value instanceof Date) {
        return value;
    }

    if (typeof value === "number") {
        if (value < 10000000000) {
            return new Date(value * 1000);
        }

        return new Date(value);
    }

    if (typeof value === "string") {
        const parsed = new Date(value);

        if (!Number.isNaN(parsed.getTime())) {
            return parsed;
        }
    }

    return null;
}


function dateMs(value) {
    const d = toDate(value);

    return d ? d.getTime() : NaN;
}


function formatDateTime(value) {
    const d = toDate(value);

    if (!d) {
        return "—";
    }

    return d.toLocaleString();
}


/* ============================================================
   CANDLE NORMALIZATION
   ============================================================ */

function normalizeCandle(raw) {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const time =
        raw.openTime ??
        raw.time ??
        raw.timestamp ??
        raw.datetime ??
        raw.date;

    const open = num(raw.open);
    const high = num(raw.high);
    const low = num(raw.low);
    const close = num(raw.close);

    const volume = num(
        raw.volume ??
        raw.tickVolume ??
        raw.tick_volume,
        0
    );

    const timestamp = dateMs(time);

    if (
        !Number.isFinite(timestamp) ||
        !Number.isFinite(open) ||
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        !Number.isFinite(close)
    ) {
        return null;
    }

    return {
        time: new Date(timestamp).toISOString(),
        openTime: new Date(timestamp).toISOString(),

        timestamp,

        open,
        high,
        low,
        close,

        volume,

        tickVolume: num(
            raw.tickVolume ??
            raw.tick_volume ??
            raw.volume,
            volume
        ),

        isOpen: Boolean(raw.isOpen)
    };
}


function normalizeCandles(rawBars) {
    if (!Array.isArray(rawBars)) {
        return [];
    }

    const normalized = [];

    for (const raw of rawBars) {
        const candle = normalizeCandle(raw);

        if (candle) {
            normalized.push(candle);
        }
    }

    return normalized;
}


/* ============================================================
   SORT / DEDUPLICATE
   ============================================================ */

function sortAndDeduplicate(candles) {
    const map = new Map();

    for (const candle of candles) {
        if (!candle || !Number.isFinite(candle.timestamp)) {
            continue;
        }

        map.set(candle.timestamp, candle);
    }

    return Array.from(map.values()).sort(
        (a, b) => a.timestamp - b.timestamp
    );
}


/* ============================================================
   API RESPONSE PARSER
   ============================================================ */

function extractBars(payload) {
    if (!payload) {
        return [];
    }

    if (Array.isArray(payload)) {
        return payload;
    }

    if (Array.isArray(payload.bars)) {
        return payload.bars;
    }

    if (payload.data && Array.isArray(payload.data.bars)) {
        return payload.data.bars;
    }

    if (payload.data && Array.isArray(payload.data)) {
        return payload.data;
    }

    if (Array.isArray(payload.result)) {
        return payload.result;
    }

    if (payload.result && Array.isArray(payload.result.bars)) {
        return payload.result.bars;
    }

    if (Array.isArray(payload.results)) {
        return payload.results;
    }

    if (payload.results && Array.isArray(payload.results.bars)) {
        return payload.results.bars;
    }

    return [];
}


/* ============================================================
   FETCH JSON
   ============================================================ */

async function fetchJSON(url, options = {}) {
    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        options.timeout || 30000
    );

    try {
        const response = await fetch(url, {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: {
                Accept: "application/json"
            }
        });

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status} ${response.statusText}`
            );
        }

        const contentType =
            response.headers.get("content-type") || "";

        const text = await response.text();

        if (!text) {
            throw new Error("Empty API response.");
        }

        if (
            !contentType.includes("application/json") &&
            text.trim().startsWith("<")
        ) {
            throw new Error(
                "API returned HTML instead of JSON."
            );
        }

        try {
            return JSON.parse(text);
        } catch (error) {
            throw new Error(
                `Invalid JSON response: ${error.message}`
            );
        }
    } finally {
        clearTimeout(timeout);
    }
}


/* ============================================================
   BUILD API URL
   ============================================================ */

function buildOHLCUrl(
    symbol,
    timeframe,
    limit,
    from = null,
    to = null
) {
    const params = new URLSearchParams();

    params.set("interval", timeframe);

    params.set(
        "limit",
        String(
            Math.min(
                Math.max(1, Number(limit) || 1),
                MAX_API_LIMIT
            )
        )
    );

    if (from) {
        params.set(
            "from",
            new Date(from).toISOString()
        );
    }

    if (to) {
        params.set(
            "to",
            new Date(to).toISOString()
        );
    }

    return `${API_BASE}/${encodeURIComponent(symbol)}/ohlc?${params.toString()}`;
}


/* ============================================================
   API REQUEST WITH RETRIES
   ============================================================ */

async function requestHistoricalChunk(
    symbol,
    timeframe,
    limit,
    from = null,
    to = null
) {
    let lastError = null;

    for (let attempt = 1; attempt <= API_ATTEMPTS; attempt++) {
        if (state.stopRequested) {
            throw new Error("Backtest stopped by user.");
        }

        try {
            log(
                `Requesting ${limit} candles for ${symbol}. Attempt ${attempt}/${API_ATTEMPTS}`
            );

            if (to) {
                log(
                    `Historical request end: ${new Date(to).toISOString()}`
                );
            }

            if (from) {
                log(
                    `Historical request start: ${new Date(from).toISOString()}`
                );
            }

            const url = buildOHLCUrl(
                symbol,
                timeframe,
                limit,
                from,
                to
            );

            const payload = await fetchJSON(url);

            const rawBars = extractBars(payload);

            log(
                `${symbol}: API envelope received. bars=${rawBars.length}`
            );

            return normalizeCandles(rawBars);
        } catch (error) {
            lastError = error;

            log(
                `${symbol}: historical request failed: ${error.message}`,
                "error"
            );

            if (attempt < API_ATTEMPTS) {
                await sleep(1000 * attempt);
            }
        }
    }

    throw lastError ||
        new Error("Historical API request failed.");
}


/* ============================================================
   SLEEP
   ============================================================ */

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}


/* ============================================================
   HISTORICAL DATA LOADER
   ============================================================

   Strategy:

   1. Request latest candles.
   2. Normalize and sort them.
   3. If API returned fewer than requested:
      - request an explicit older date range.
   4. If API refuses older data:
      - safely stop.
   5. Never manufacture candles.
   6. Never claim more history than actually exists.

   ============================================================ */

async function loadHistoricalData(
    symbol,
    timeframe,
    targetCount
) {
    log(
        `Loading historical data: ${symbol} ${timeframe} target=${targetCount}`
    );

    setProgress(5, "Loading historical data...");

    let allCandles = [];

    /*
       First request: latest available history.
    */
    const firstChunk = await requestHistoricalChunk(
        symbol,
        timeframe,
        Math.min(targetCount, MAX_API_LIMIT)
    );

    log(
        `${symbol}: raw API candles = ${firstChunk.length}`
    );

    allCandles = sortAndDeduplicate(firstChunk);

    log(
        `${symbol}: normalized candles = ${allCandles.length}`
    );

    if (allCandles.length === 0) {
        throw new Error(
            `No historical candles were returned for ${symbol}.`
        );
    }

    log(
        `${symbol}: first historical chunk = ${allCandles.length}; total=${allCandles.length}`
    );

    /*
       Continue until target is reached or API genuinely
       stops providing older data.
    */
    let noProgressCount = 0;

    while (
        allCandles.length < targetCount &&
        !state.stopRequested
    ) {
        const oldest =
            allCandles[0];

        if (!oldest) {
            break;
        }

        const tfMs =
            timeframeMilliseconds(timeframe);

        /*
           Instead of relying only on "to", explicitly provide
           both FROM and TO.

           This handles APIs that behave differently when
           only "to" is supplied.
        */
        const requestedRemaining =
            targetCount - allCandles.length;

        const requestBars = Math.min(
            Math.max(
                requestedRemaining * 2,
                250
            ),
            MAX_API_LIMIT
        );

        const to =
            oldest.timestamp - 1;

        const from =
            to -
            (
                requestBars *
                tfMs
            );

        log(
            `Requesting ${requestBars} older ${timeframe} candles for ${symbol}.`
        );

        let older = [];

        try {
            older =
                await requestHistoricalChunk(
                    symbol,
                    timeframe,
                    requestBars,
                    from,
                    to
                );
        } catch (error) {
            log(
                `Older historical request stopped: ${error.message}`,
                "error"
            );

            break;
        }

        if (!older.length) {
            noProgressCount++;

            log(
                `Historical request returned 0 older candles. Attempt ${noProgressCount}.`
            );

            /*
               A second attempt with a wider range can sometimes
               work when the API rejects a narrow date window.
            */
            if (noProgressCount < 2) {
                const widerTo =
                    oldest.timestamp - 1;

                const widerFrom =
                    widerTo -
                    (
                        targetCount *
                        5 *
                        tfMs
                    );

                try {
                    const wider =
                        await requestHistoricalChunk(
                            symbol,
                            timeframe,
                            Math.min(
                                targetCount,
                                MAX_API_LIMIT
                            ),
                            widerFrom,
                            widerTo
                        );

                    if (wider.length) {
                        allCandles =
                            sortAndDeduplicate([
                                ...allCandles,
                                ...wider
                            ]);

                        noProgressCount = 0;

                        continue;
                    }
                } catch (error) {
                    log(
                        `Wider historical request failed: ${error.message}`,
                        "error"
                    );
                }
            }

            break;
        }

        const before =
            allCandles.length;

        allCandles =
            sortAndDeduplicate([
                ...allCandles,
                ...older
            ]);

        const after =
            allCandles.length;

        log(
            `${symbol}: older chunk=${older.length}; unique total=${after}`
        );

        if (after <= before) {
            noProgressCount++;

            if (noProgressCount >= 2) {
                break;
            }
        } else {
            noProgressCount = 0;
        }

        const percent =
            5 +
            (
                Math.min(
                    allCandles.length /
                    targetCount,
                    1
                ) * 25
            );

        setProgress(
            percent,
            `${allCandles.length} / ${targetCount} candles`
        );
    }

    allCandles =
        sortAndDeduplicate(allCandles);

    /*
       Remove an open/current candle because it can change
       while the backtest is running.
    */
    allCandles =
        allCandles.filter(
            candle => !candle.isOpen
        );

    /*
       Keep only the requested number of candles.
    */
    if (allCandles.length > targetCount) {
        allCandles =
            allCandles.slice(
                allCandles.length - targetCount
            );
    }

    log(
        `${symbol}: historical loading complete. ${allCandles.length} unique closed candles.`
    );

    if (allCandles.length > 0) {
        log(
            `Historical range: ${formatDateTime(allCandles[0].timestamp)} → ${formatDateTime(allCandles[allCandles.length - 1].timestamp)}`
        );
    }

    if (allCandles.length < targetCount) {
        log(
            `WARNING: API supplied only ${allCandles.length} of ${targetCount} requested candles. Backtest will use the actual available history.`,
            "error"
        );
    }

    return allCandles;
}


/* ============================================================
   AI ANALYSIS
   ============================================================ */

function analyzeHistorical(symbol, candles) {
    const engine = getAIEngine();

    /*
       The SAME AI engine is used.

       No future candles are passed into this function.
    */
    if (typeof engine.analyzeHistorical === "function") {
        return engine.analyzeHistorical(
            symbol,
            candles
        );
    }

    if (typeof engine.analyze === "function") {
        return engine.analyze(
            symbol,
            candles
        );
    }

    throw new Error(
        "AIEngine does not expose analyzeHistorical() or analyze()."
    );
}


/* ============================================================
   ANALYSIS HELPERS
   ============================================================ */

function extractSetup(analysis) {
    if (!analysis) {
        return null;
    }

    if (analysis.setup) {
        return analysis.setup;
    }

    if (
        analysis.result &&
        analysis.result.setup
    ) {
        return analysis.result.setup;
    }

    if (
        analysis.candidate &&
        analysis.candidate.entry !== undefined
    ) {
        return analysis.candidate;
    }

    if (
        analysis.entry !== undefined &&
        analysis.stop !== undefined &&
        analysis.target !== undefined
    ) {
        return analysis;
    }

    return null;
}


function extractScore(analysis, setup) {
    return num(
        setup?.score ??
        analysis?.score ??
        analysis?.confidence ??
        0,
        0
    );
}


function extractConfirmations(analysis, setup) {
    return num(
        setup?.confirmations ??
        analysis?.confirmations ??
        setup?.confirmationCount ??
        analysis?.confirmationCount ??
        0,
        0
    );
}


function extractRR(analysis, setup) {
    return num(
        setup?.rr ??
        setup?.riskReward ??
        setup?.riskRewardRatio ??
        analysis?.rr ??
        analysis?.riskReward ??
        0,
        0
    );
}


function extractDirection(analysis, setup) {
    const direction =
        setup?.direction ??
        setup?.side ??
        analysis?.direction ??
        analysis?.bias ??
        "";

    const value =
        String(direction)
            .trim()
            .toUpperCase();

    if (
        value === "LONG" ||
        value === "BUY"
    ) {
        return "LONG";
    }

    if (
        value === "SHORT" ||
        value === "SELL"
    ) {
        return "SHORT";
    }

    return value || "UNKNOWN";
}


function extractEntry(analysis, setup) {
    return num(
        setup?.entry ??
        setup?.entryPrice ??
        analysis?.entry ??
        analysis?.entryPrice
    );
}


function extractStop(analysis, setup) {
    return num(
        setup?.stop ??
        setup?.stopLoss ??
        setup?.sl ??
        analysis?.stop ??
        analysis?.stopLoss ??
        analysis?.sl
    );
}


function extractTarget(analysis, setup) {
    return num(
        setup?.target ??
        setup?.takeProfit ??
        setup?.tp ??
        analysis?.target ??
        analysis?.takeProfit ??
        analysis?.tp
    );
}


function extractStrategy(analysis, setup) {
    return (
        setup?.strategy ??
        setup?.strategyName ??
        analysis?.strategy ??
        analysis?.strategyName ??
        "AI Confluence"
    );
}


/* ============================================================
   A+ VALIDATION
   ============================================================ */

function isAPlus(analysis, setup) {
    if (!setup) {
        return false;
    }

    const score =
        extractScore(
            analysis,
            setup
        );

    const confirmations =
        extractConfirmations(
            analysis,
            setup
        );

    const rr =
        extractRR(
            analysis,
            setup
        );

    /*
       The backtester does NOT lower these requirements.
    */
    return (
        score >= A_PLUS_SCORE &&
        confirmations >= A_PLUS_CONFIRMATIONS &&
        rr >= A_PLUS_RR
    );
}


/* ============================================================
   FUTURE-CANDLE TRADE SIMULATION
   ============================================================

   IMPORTANT:

   Future candles are ONLY used after a signal has already
   been generated.

   They cannot influence the signal.

   ============================================================ */

function simulateTrade(
    trade,
    futureBars
) {
    if (!trade) {
        return {
            outcome: "OPEN",
            r: 0,
            exitPrice: null,
            exitTime: null,
            barsHeld: 0
        };
    }

    const direction =
        trade.direction;

    const entry =
        trade.entry;

    const stop =
        trade.stop;

    const target =
        trade.target;

    const maxBars =
        Math.max(
            1,
            Number(
                state.forwardBars ||
                DEFAULT_FORWARD_BARS
            )
        );

    const bars =
        Array.isArray(futureBars)
            ? futureBars.slice(
                0,
                maxBars
            )
            : [];

    for (
        let i = 0;
        i < bars.length;
        i++
    ) {
        const candle =
            bars[i];

        const high =
            num(candle.high);

        const low =
            num(candle.low);

        if (
            !Number.isFinite(high) ||
            !Number.isFinite(low)
        ) {
            continue;
        }

        /*
           LONG
           ----
           Stop = low touched.
           Target = high touched.
        */
        if (direction === "LONG") {
            const stopHit =
                low <= stop;

            const targetHit =
                high >= target;

            /*
               Conservative rule:
               if both are touched in the same candle,
               assume STOP was hit first.

               This avoids giving the strategy a free
               favorable intrabar assumption.
            */
            if (
                stopHit &&
                targetHit
            ) {
                return {
                    outcome: "LOSS",
                    r: -1,
                    exitPrice: stop,
                    exitTime: candle.timestamp,
                    barsHeld: i + 1
                };
            }

            if (stopHit) {
                return {
                    outcome: "LOSS",
                    r: -1,
                    exitPrice: stop,
                    exitTime: candle.timestamp,
                    barsHeld: i + 1
                };
            }

            if (targetHit) {
                return {
                    outcome: "WIN",
                    r: trade.rr,
                    exitPrice: target,
                    exitTime: candle.timestamp,
                    barsHeld: i + 1
                };
            }
        }


        /*
           SHORT
           -----
        */
        if (direction === "SHORT") {
            const stopHit =
                high >= stop;

            const targetHit =
                low <= target;

            if (
                stopHit &&
                targetHit
            ) {
                return {
                    outcome: "LOSS",
                    r: -1,
                    exitPrice: stop,
                    exitTime: candle.timestamp,
                    barsHeld: i + 1
                };
            }

            if (stopHit) {
                return {
                    outcome: "LOSS",
                    r: -1,
                    exitPrice: stop,
                    exitTime: candle.timestamp,
                    barsHeld: i + 1
                };
            }

            if (targetHit) {
                return {
                    outcome: "WIN",
                    r: trade.rr,
                    exitPrice: target,
                    exitTime: candle.timestamp,
                    barsHeld: i + 1
                };
            }
        }
    }

    /*
       Dataset ended before the complete forward window.
    */
    if (bars.length < maxBars) {
        return {
            outcome: "OPEN",
            r: 0,
            exitPrice: null,
            exitTime: null,
            barsHeld: bars.length
        };
    }

    /*
       Full 3-hour window completed without TP or SL.
    */
    return {
        outcome: "EXPIRED",
        r: 0,
        exitPrice: null,
        exitTime: bars[bars.length - 1]?.timestamp || null,
        barsHeld: bars.length
    };
}


/* ============================================================
   BACKTEST ANALYSIS
   ============================================================ */

async function runBacktestAnalysis(
    symbol,
    candles
) {
    const warmup =
        Math.max(
            1,
            Number(state.warmup) ||
            DEFAULT_WARMUP
        );

    const forwardBars =
        Math.max(
            1,
            Number(state.forwardBars) ||
            DEFAULT_FORWARD_BARS
        );

    const trades = [];
    const decisions = [];

    /*
       This index prevents overlapping A+ trades.

       Once an A+ trade is opened, the next signal cannot be
       opened until that trade's maximum holding window has
       completed.
    */
    let nextAvailableIndex =
        warmup;

    const totalIterations =
        Math.max(
            0,
            candles.length -
            warmup -
            forwardBars
        );

    let processed = 0;

    for (
        let i = warmup;
        i < candles.length;
        i++
    ) {
        if (state.stopRequested) {
            break;
        }

        /*
           We cannot evaluate a complete trade if there are
           not enough future candles.
        */
        if (
            i + 1 >= candles.length
        ) {
            break;
        }

        /*
           Avoid overlapping A+ trades.
        */
        if (
            i < nextAvailableIndex
        ) {
            continue;
        }

        const historicalBars =
            candles.slice(
                0,
                i + 1
            );

        let analysis = null;

        try {
            /*
               CRITICAL:

               Only candles up to the signal candle are passed
               to the AI engine.

               No future candle leakage.
            */
            analysis =
                analyzeHistorical(
                    symbol,
                    historicalBars
                );
        } catch (error) {
            state.consistency.errors++;

            log(
                `AI analysis error at ${formatDateTime(candles[i].timestamp)}: ${error.message}`,
                "error"
            );

            continue;
        }

        const setup =
            extractSetup(
                analysis
            );

        const score =
            extractScore(
                analysis,
                setup
            );

        const confirmations =
            extractConfirmations(
                analysis,
                setup
            );

        const rr =
            extractRR(
                analysis,
                setup
            );

        const aPlus =
            isAPlus(
                analysis,
                setup
            );

        decisions.push({
            index: i,
            time: candles[i].timestamp,
            score,
            confirmations,
            rr,
            aPlus,
            analysis
        });

        if (!aPlus) {
            processed++;

            if (
                totalIterations > 0 &&
                processed % 10 === 0
            ) {
                const percent =
                    30 +
                    (
                        processed /
                        totalIterations
                    ) * 40;

                setProgress(
                    percent,
                    `Scanning AI signals ${processed}/${totalIterations}`
                );
            }

            continue;
        }

        const direction =
            extractDirection(
                analysis,
                setup
            );

        const entry =
            extractEntry(
                analysis,
                setup
            );

        const stop =
            extractStop(
                analysis,
                setup
            );

        const target =
            extractTarget(
                analysis,
                setup
            );

        const strategy =
            extractStrategy(
                analysis,
                setup
            );

        if (
            !Number.isFinite(entry) ||
            !Number.isFinite(stop) ||
            !Number.isFinite(target)
        ) {
            log(
                `A+ signal ignored because entry/stop/target was invalid at ${formatDateTime(candles[i].timestamp)}.`,
                "error"
            );

            continue;
        }

        if (
            direction !== "LONG" &&
            direction !== "SHORT"
        ) {
            log(
                `A+ signal ignored because direction was invalid at ${formatDateTime(candles[i].timestamp)}.`,
                "error"
            );

            continue;
        }

        const futureBars =
            candles.slice(
                i + 1,
                i + 1 + forwardBars
            );

        const trade = {
            id: trades.length + 1,

            index: i,

            time:
                candles[i].timestamp,

            direction,

            entry,

            stop,

            target,

            score,

            confirmations,

            rr,

            strategy,

            analysis
        };

        const result =
            simulateTrade(
                trade,
                futureBars
            );

        trade.outcome =
            result.outcome;

        trade.r =
            num(
                result.r,
                0
            );

        trade.exitPrice =
            result.exitPrice;

        trade.exitTime =
            result.exitTime;

        trade.barsHeld =
            result.barsHeld;

        trade.holdingTime =
            formatDurationBars(
                result.barsHeld,
                state.timeframe
            );

        trades.push(trade);

        /*
           Prevent overlapping signals.

           If trade starts at candle i and has a 36-candle
           maximum life, the next independent trade begins
           after that window.
        */
        nextAvailableIndex =
            i +
            forwardBars +
            1;

        log(
            `A+ #${trade.id}: ${direction} ${formatDateTime(trade.time)} | score=${score} | conf=${confirmations} | RR=${round(rr, 2)} | ${result.outcome} ${result.r >= 0 ? "+" : ""}${round(result.r, 2)}R`
        );

        processed++;

        if (
            totalIterations > 0
        ) {
            const percent =
                30 +
                (
                    processed /
                    totalIterations
                ) * 40;

            setProgress(
                Math.min(
                    percent,
                    70
                ),
                `Scanning AI signals`
            );
        }
    }

    return {
        trades,
        decisions
    };
}


/* ============================================================
   CONSISTENCY TEST
   ============================================================

   This checks that the AI sees only historical candles.

   Future candles are NOT passed to the engine.

   ============================================================ */

async function runConsistencyTest(
    symbol,
    candles
) {
    log("Running AI consistency test...");

    const warmup =
        Math.max(
            1,
            Number(state.warmup) ||
            DEFAULT_WARMUP
        );

    let decisions = 0;
    let aPlus = 0;
    let wait = 0;
    let leakage = 0;
    let errors = 0;

    for (
        let i = warmup;
        i < candles.length;
        i++
    ) {
        if (state.stopRequested) {
            break;
        }

        /*
           The last candle can still be analyzed as a signal,
           but no future data is required for the AI decision.
        */
        const historicalBars =
            candles.slice(
                0,
                i + 1
            );

        try {
            const analysis =
                analyzeHistorical(
                    symbol,
                    historicalBars
                );

            const setup =
                extractSetup(
                    analysis
                );

            const score =
                extractScore(
                    analysis,
                    setup
                );

            const confirmations =
                extractConfirmations(
                    analysis,
                    setup
                );

            const rr =
                extractRR(
                    analysis,
                    setup
                );

            const qualifies =
                isAPlus(
                    analysis,
                    setup
                );

            decisions++;

            if (qualifies) {
                aPlus++;
            } else {
                wait++;
            }

            /*
               Basic leakage sanity check.

               The engine should never report that it used a
               candle timestamp later than the signal candle.
            */
            const analysisTime =
                dateMs(
                    analysis?.time ??
                    analysis?.timestamp ??
                    analysis?.signalTime
                );

            if (
                Number.isFinite(
                    analysisTime
                ) &&
                analysisTime >
                candles[i].timestamp
            ) {
                leakage++;
            }

            /*
               Ensure A+ values are internally consistent.
            */
            if (
                qualifies &&
                (
                    score < A_PLUS_SCORE ||
                    confirmations < A_PLUS_CONFIRMATIONS ||
                    rr < A_PLUS_RR
                )
            ) {
                errors++;
            }
        } catch (error) {
            errors++;

            log(
                `Consistency test error at index ${i}: ${error.message}`,
                "error"
            );
        }
    }

    state.consistency = {
        decisions,
        aPlus,
        wait,
        leakage,
        errors
    };

    log(
        `Consistency complete: ${decisions} decisions, ${aPlus} A+, ${wait} WAIT, leakage=${leakage}, errors=${errors}`
    );

    renderConsistency();

    return state.consistency;
}


/* ============================================================
   CALCULATE STATISTICS
   ============================================================ */

function calculateStats(trades) {
    let wins = 0;
    let losses = 0;
    let expired = 0;
    let open = 0;

    let netR = 0;

    let grossProfit = 0;
    let grossLoss = 0;

    let equity = 0;
    let peak = 0;
    let maxDD = 0;

    for (const trade of trades) {
        const r =
            num(
                trade.r,
                0
            );

        netR += r;
        equity += r;

        if (equity > peak) {
            peak = equity;
        }

        const drawdown =
            equity - peak;

        if (
            drawdown < maxDD
        ) {
            maxDD = drawdown;
        }

        switch (trade.outcome) {
            case "WIN":
                wins++;

                grossProfit +=
                    Math.max(
                        0,
                        r
                    );

                break;

            case "LOSS":
                losses++;

                grossLoss +=
                    Math.abs(
                        Math.min(
                            0,
                            r
                        )
                    );

                break;

            case "EXPIRED":
                expired++;
                break;

            case "OPEN":
                open++;
                break;
        }
    }

    const closed =
        wins + losses;

    const winRate =
        closed > 0
            ? (
                wins /
                closed
            ) * 100
            : 0;

    const profitFactor =
        grossLoss > 0
            ? grossProfit /
              grossLoss
            : grossProfit > 0
                ? Infinity
                : 0;

    state.stats = {
        total: trades.length,
        wins,
        losses,
        expired,
        open,
        netR,
        profitFactor,
        maxDD,
        winRate
    };

    return state.stats;
}


/* ============================================================
   RENDER STATS
   ============================================================ */

function renderStats() {
    const stats =
        state.stats;

    setText(
        "totalTrades",
        stats.total
    );

    setText(
        "wins",
        stats.wins
    );

    setText(
        "losses",
        stats.losses
    );

    setText(
        "breakeven",
        stats.expired
    );

    setText(
        "winRate",
        `${round(stats.winRate, 2)}%`
    );

    setText(
        "netR",
        `${stats.netR >= 0 ? "+" : ""}${round(stats.netR, 2)}R`
    );

    setText(
        "profitFactor",
        Number.isFinite(stats.profitFactor)
            ? round(
                stats.profitFactor,
                2
            )
            : "∞"
    );

    setText(
        "maxDD",
        `${round(stats.maxDD, 2)}R`
    );
}


/* ============================================================
   RENDER SUMMARY
   ============================================================ */

function renderSummary() {
    const candles =
        state.historicalBars;

    setText(
        "summaryMarket",
        state.market
    );

    setText(
        "summaryTimeframe",
        state.timeframe
    );

    setText(
        "summaryCandles",
        candles.length
    );

    setText(
        "summarySignals",
        state.trades.length
    );

    let regime =
        "—";

    /*
       Use the last AI analysis for summary if available.
    */
    try {
        if (candles.length) {
            const analysis =
                analyzeHistorical(
                    state.market,
                    candles
                );

            regime =
                analysis?.regime ??
                analysis?.marketRegime ??
                analysis?.bias ??
                "—";
        }
    } catch (error) {
        regime = "—";
    }

    setText(
        "summaryRegime",
        String(regime)
    );

    setText(
        "summaryEngine",
        getEngineName()
    );
}


/* ============================================================
   RENDER CONSISTENCY
   ============================================================ */

function renderConsistency() {
    const el =
        $("consistencyResults");

    if (!el) {
        return;
    }

    const c =
        state.consistency;

    const passed =
        c.leakage === 0 &&
        c.errors === 0;

    el.innerHTML = `
        <div class="consistency-grid">
            <div>
                <strong>Decisions</strong>
                <span>${c.decisions}</span>
            </div>

            <div>
                <strong>A+ Decisions</strong>
                <span>${c.aPlus}</span>
            </div>

            <div>
                <strong>WAIT</strong>
                <span>${c.wait}</span>
            </div>

            <div>
                <strong>Future Leakage</strong>
                <span>${c.leakage}</span>
            </div>

            <div>
                <strong>Errors</strong>
                <span>${c.errors}</span>
            </div>

            <div>
                <strong>Result</strong>
                <span>${passed ? "PASSED" : "CHECK REQUIRED"}</span>
            </div>
        </div>
    `;
}


/* ============================================================
   STRATEGY TABLE
   ============================================================

   Correct column order:

   Strategy
   Trades
   Wins
   Losses
   Win Rate
   Net R
   Expired / Open

   ============================================================ */

function renderStrategyTable() {
    const body =
        $("strategyBody");

    if (!body) {
        return;
    }

    body.innerHTML = "";

    const groups =
        new Map();

    for (const trade of state.trades) {
        const name =
            trade.strategy ||
            "AI Confluence";

        if (!groups.has(name)) {
            groups.set(
                name,
                {
                    strategy: name,
                    trades: 0,
                    wins: 0,
                    losses: 0,
                    expired: 0,
                    open: 0,
                    netR: 0
                }
            );
        }

        const group =
            groups.get(name);

        group.trades++;

        group.netR +=
            num(
                trade.r,
                0
            );

        if (trade.outcome === "WIN") {
            group.wins++;
        }

        if (trade.outcome === "LOSS") {
            group.losses++;
        }

        if (trade.outcome === "EXPIRED") {
            group.expired++;
        }

        if (trade.outcome === "OPEN") {
            group.open++;
        }
    }

    if (groups.size === 0) {
        body.innerHTML = `
            <tr>
                <td colspan="7">
                    No A+ trades.
                </td>
            </tr>
        `;

        return;
    }

    for (const group of groups.values()) {
        const closed =
            group.wins +
            group.losses;

        const winRate =
            closed > 0
                ? (
                    group.wins /
                    closed
                ) * 100
                : 0;

        const row =
            document.createElement("tr");

        row.innerHTML = `
            <td>${escapeHTML(group.strategy)}</td>
            <td>${group.trades}</td>
            <td>${group.wins}</td>
            <td>${group.losses}</td>
            <td>${round(winRate, 2)}%</td>
            <td>${group.netR >= 0 ? "+" : ""}${round(group.netR, 2)}R</td>
            <td>${group.expired} / ${group.open}</td>
        `;

        body.appendChild(row);
    }
}


/* ============================================================
   TRADE LOG
   ============================================================

   Correct column order:

   ID
   Time
   Direction
   Entry
   Stop
   Target
   Score
   Confirmations
   R:R
   Strategy
   Outcome
   R

   ============================================================ */

function renderTradeLog() {
    const body =
        $("tradeLogBody");

    if (!body) {
        return;
    }

    body.innerHTML = "";

    if (
        state.trades.length === 0
    ) {
        body.innerHTML = `
            <tr>
                <td colspan="12">
                    No A+ trades generated.
                </td>
            </tr>
        `;

        return;
    }

    for (const trade of state.trades) {
        const row =
            document.createElement("tr");

        const rText =
            `${trade.r >= 0 ? "+" : ""}${round(trade.r, 2)}R`;

        row.innerHTML = `
            <td>${trade.id}</td>

            <td>
                ${escapeHTML(
                    formatDateTime(
                        trade.time
                    )
                )}
            </td>

            <td>
                ${escapeHTML(
                    trade.direction
                )}
            </td>

            <td>
                ${formatPrice(
                    trade.entry
                )}
            </td>

            <td>
                ${formatPrice(
                    trade.stop
                )}
            </td>

            <td>
                ${formatPrice(
                    trade.target
                )}
            </td>

            <td>
                ${round(
                    trade.score,
                    0
                )}
            </td>

            <td>
                ${round(
                    trade.confirmations,
                    0
                )}
            </td>

            <td>
                ${round(
                    trade.rr,
                    2
                )}
            </td>

            <td>
                ${escapeHTML(
                    trade.strategy
                )}
            </td>

            <td>
                ${escapeHTML(
                    trade.outcome
                )}
            </td>

            <td>
                ${rText}
            </td>
        `;

        body.appendChild(row);
    }
}


/* ============================================================
   DIAGNOSTICS
   ============================================================ */

function renderDiagnostics() {
    const el =
        $("diagnostics");

    if (!el) {
        return;
    }

    const candles =
        state.historicalBars;

    const first =
        candles[0];

    const last =
        candles[candles.length - 1];

    const duration =
        first &&
        last
            ? (
                last.timestamp -
                first.timestamp
            ) / 3600000
            : 0;

    const forwardBars =
        state.forwardBars;

    const holdingTime =
        formatDurationBars(
            forwardBars,
            state.timeframe
        );

    el.innerHTML = `
        <div class="diagnostic-grid">

            <div>
                <strong>Market</strong>
                <span>${escapeHTML(state.market)}</span>
            </div>

            <div>
                <strong>Timeframe</strong>
                <span>${escapeHTML(state.timeframe)}</span>
            </div>

            <div>
                <strong>Actual Candles</strong>
                <span>${candles.length}</span>
            </div>

            <div>
                <strong>Requested Candles</strong>
                <span>${state.candles}</span>
            </div>

            <div>
                <strong>Historical Duration</strong>
                <span>${round(duration, 2)} hours</span>
            </div>

            <div>
                <strong>Maximum Trade Life</strong>
                <span>${escapeHTML(holdingTime)}</span>
            </div>

            <div>
                <strong>A+ Score</strong>
                <span>≥ ${A_PLUS_SCORE}</span>
            </div>

            <div>
                <strong>Confirmations</strong>
                <span>≥ ${A_PLUS_CONFIRMATIONS}</span>
            </div>

            <div>
                <strong>Minimum R:R</strong>
                <span>≥ ${A_PLUS_RR}</span>
            </div>

            <div>
                <strong>Overlapping Trades</strong>
                <span>Blocked</span>
            </div>

            <div>
                <strong>Future Leakage</strong>
                <span>${state.consistency.leakage}</span>
            </div>

            <div>
                <strong>Engine</strong>
                <span>${escapeHTML(getEngineName())}</span>
            </div>

        </div>

        <div class="diagnostic-note">
            ${
                candles.length < state.candles
                    ? `
                        <strong>Important:</strong>
                        The API supplied only
                        ${candles.length}
                        closed candles instead of the requested
                        ${state.candles}.
                        The backtest uses only the actual
                        historical data returned by the API.
                      `
                    : `
                        Historical target reached.
                        The backtest contains
                        ${candles.length}
                        closed candles.
                      `
            }
        </div>
    `;

    if (first && last) {
        log(
            `Backtest range: ${formatDateTime(first.timestamp)} → ${formatDateTime(last.timestamp)}`
        );
    }
}


/* ============================================================
   EQUITY CURVE
   ============================================================ */

function renderEquityCurve() {
    const canvas =
        $("equityCurve");

    if (!canvas) {
        return;
    }

    const ctx =
        canvas.getContext("2d");

    if (!ctx) {
        return;
    }

    const rect =
        canvas.getBoundingClientRect();

    const width =
        Math.max(
            400,
            Math.floor(
                rect.width ||
                canvas.clientWidth ||
                800
            )
        );

    const height =
        Math.max(
            220,
            Math.floor(
                rect.height ||
                canvas.clientHeight ||
                300
            )
        );

    const dpr =
        window.devicePixelRatio ||
        1;

    canvas.width =
        width * dpr;

    canvas.height =
        height * dpr;

    ctx.setTransform(
        dpr,
        0,
        0,
        dpr,
        0,
        0
    );

    ctx.clearRect(
        0,
        0,
        width,
        height
    );

    if (
        state.trades.length === 0
    ) {
        ctx.fillText(
            "No trades to display.",
            20,
            30
        );

        return;
    }

    const values = [0];

    let equity = 0;

    for (const trade of state.trades) {
        equity +=
            num(
                trade.r,
                0
            );

        values.push(equity);
    }

    const minValue =
        Math.min(
            ...values,
            0
        );

    const maxValue =
        Math.max(
            ...values,
            0
        );

    const range =
        Math.max(
            1,
            maxValue - minValue
        );

    const padding = 35;

    const chartWidth =
        width -
        padding * 2;

    const chartHeight =
        height -
        padding * 2;

    /*
       Zero line.
    */
    const zeroY =
        padding +
        (
            maxValue /
            range
        ) *
        chartHeight;

    ctx.beginPath();

    ctx.moveTo(
        padding,
        zeroY
    );

    ctx.lineTo(
        width - padding,
        zeroY
    );

    ctx.stroke();

    /*
       Equity line.
    */
    ctx.beginPath();

    values.forEach(
        (value, index) => {
            const x =
                padding +
                (
                    index /
                    Math.max(
                        1,
                        values.length - 1
                    )
                ) *
                chartWidth;

            const y =
                padding +
                (
                    (
                        maxValue -
                        value
                    ) /
                    range
                ) *
                chartHeight;

            if (index === 0) {
                ctx.moveTo(
                    x,
                    y
                );
            } else {
                ctx.lineTo(
                    x,
                    y
                );
            }
        }
    );

    ctx.stroke();
}


/* ============================================================
   ESCAPE HTML
   ============================================================ */

function escapeHTML(value) {
    return String(
        value ??
        ""
    )
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );
}


/* ============================================================
   PRICE FORMAT
   ============================================================ */

function formatPrice(value) {
    const n =
        Number(value);

    if (!Number.isFinite(n)) {
        return "—";
    }

    /*
       Preserve enough precision for different instruments.
    */
    if (
        Math.abs(n) >= 10000
    ) {
        return n.toFixed(2);
    }

    if (
        Math.abs(n) >= 1000
    ) {
        return n.toFixed(2);
    }

    if (
        Math.abs(n) >= 100
    ) {
        return n.toFixed(2);
    }

    if (
        Math.abs(n) >= 1
    ) {
        return n.toFixed(2);
    }

    return n.toFixed(5);
}


/* ============================================================
   CLEAR RESULTS
   ============================================================ */

function clearResults() {
    state.historicalBars = [];
    state.trades = [];
    state.decisions = [];

    state.stats = {
        total: 0,
        wins: 0,
        losses: 0,
        expired: 0,
        open: 0,
        netR: 0,
        profitFactor: 0,
        maxDD: 0,
        winRate: 0
    };

    state.consistency = {
        decisions: 0,
        aPlus: 0,
        wait: 0,
        leakage: 0,
        errors: 0
    };

    renderStats();
    renderSummary();
    renderConsistency();
    renderStrategyTable();
    renderTradeLog();
    renderDiagnostics();
    renderEquityCurve();
}


/* ============================================================
   READ CONTROLS
   ============================================================ */

function readControls() {
    const market =
        $("market")?.value ||
        DEFAULT_MARKET;

    const timeframe =
        $("timeframe")?.value ||
        DEFAULT_TIMEFRAME;

    const candles =
        Math.max(
            100,
            Number(
                $("candles")?.value ||
                DEFAULT_CANDLES
            )
        );

    const warmup =
        Math.max(
            20,
            Number(
                $("warmup")?.value ||
                DEFAULT_WARMUP
            )
        );

    const forwardBars =
        Math.max(
            1,
            Number(
                $("forwardBars")?.value ||
                DEFAULT_FORWARD_BARS
            )
        );

    state.market =
        String(
            market
        ).toUpperCase();

    state.timeframe =
        timeframe;

    state.candles =
        candles;

    state.warmup =
        warmup;

    state.forwardBars =
        forwardBars;

    /*
       Keep UI synchronized.
    */
    if ($("candles")) {
        $("candles").value =
            String(candles);
    }

    if ($("warmup")) {
        $("warmup").value =
            String(warmup);
    }

    if ($("forwardBars")) {
        $("forwardBars").value =
            String(forwardBars);
    }
}


/* ============================================================
   RUN BACKTEST
   ============================================================ */

async function runBacktest() {
    if (state.running) {
        log(
            "A backtest is already running."
        );

        return;
    }

    state.running = true;
    state.stopRequested = false;

    state.startTime =
        Date.now();

    clearResults();

    try {
        readControls();

        const engine =
            getAIEngine();

        log(
            `Backtester 4.0.0-INTRADAY-CLEAN initialized.`
        );

        log(
            `AI Engine: ${getEngineName()}`
        );

        log(
            `Starting backtest: ${state.market} ${state.timeframe}`
        );

        log(
            `Target historical candles: ${state.candles}`
        );

        log(
            `Warmup candles: ${state.warmup}`
        );

        log(
            `Maximum trade life: ${state.forwardBars} candles (${formatDurationBars(state.forwardBars, state.timeframe)})`
        );

        log(
            `A+ requirements: score >= ${A_PLUS_SCORE}, confirmations >= ${A_PLUS_CONFIRMATIONS}, R:R >= ${A_PLUS_RR}`
        );

        if (!engine) {
            throw new Error(
                "AI Engine unavailable."
            );
        }

        setStatus(
            "Loading historical data..."
        );

        setProgress(
            2,
            "Starting..."
        );

        /*
           Load historical data.
        */
        const candles =
            await loadHistoricalData(
                state.market,
                state.timeframe,
                state.candles
            );

        if (state.stopRequested) {
            throw new Error(
                "Backtest stopped by user."
            );
        }

        state.historicalBars =
            candles;

        log(
            `Historical candles: ${candles.length}`
        );

        if (candles.length > 0) {
            log(
                `Range: ${formatDateTime(candles[0].timestamp)} → ${formatDateTime(candles[candles.length - 1].timestamp)}`
            );
        }

        /*
           Check that enough data exists for at least
           one complete signal window.
        */
        if (
            candles.length <=
            state.warmup +
            state.forwardBars
        ) {
            throw new Error(
                `Not enough historical candles. Need more than ${state.warmup + state.forwardBars}, but only ${candles.length} were returned.`
            );
        }

        setStatus(
            "Testing AI consistency..."
        );

        setProgress(
            30,
            "Running consistency test..."
        );

        await runConsistencyTest(
            state.market,
            candles
        );

        if (state.stopRequested) {
            throw new Error(
                "Backtest stopped by user."
            );
        }

        setStatus(
            "Running historical AI backtest..."
        );

        setProgress(
            35,
            "Scanning historical candles..."
        );

        const result =
            await runBacktestAnalysis(
                state.market,
                candles
            );

        state.trades =
            result.trades;

        state.decisions =
            result.decisions;

        calculateStats(
            state.trades
        );

        /*
           Render everything.
        */
        renderStats();
        renderSummary();
        renderConsistency();
        renderStrategyTable();
        renderTradeLog();
        renderDiagnostics();
        renderEquityCurve();

        setProgress(
            100,
            "Complete"
        );

        setStatus(
            "Backtest complete."
        );

        log(
            `Backtest complete: ${state.trades.length} A+ signals.`
        );

        log(
            `Wins=${state.stats.wins}, Losses=${state.stats.losses}, Expired=${state.stats.expired}, Open=${state.stats.open}`
        );

        log(
            `Closed-trade win rate=${round(state.stats.winRate, 2)}%`
        );

        log(
            `Net result=${state.stats.netR >= 0 ? "+" : ""}${round(state.stats.netR, 2)}R`
        );

        log(
            `Profit factor=${Number.isFinite(state.stats.profitFactor) ? round(state.stats.profitFactor, 2) : "∞"}`
        );

        log(
            `Maximum drawdown=${round(state.stats.maxDD, 2)}R`
        );

        log(
            `Maximum holding window=${formatDurationBars(state.forwardBars, state.timeframe)}`
        );

        if (
            candles.length <
            state.candles
        ) {
            log(
                `IMPORTANT: this result is based on ${candles.length} actual historical candles, not the requested ${state.candles}.`,
                "error"
            );
        }

    } catch (error) {
        console.error(error);

        setStatus(
            "Backtest failed."
        );

        setProgress(
            100,
            "Failed"
        );

        log(
            `BACKTEST ERROR: ${error.message}`,
            "error"
        );

    } finally {
        state.running = false;

        state.endTime =
            Date.now();

        const seconds =
            (
                state.endTime -
                state.startTime
            ) / 1000;

        log(
            `Backtest process finished in ${round(seconds, 2)} seconds.`
        );
    }
}


/* ============================================================
   STOP BACKTEST
   ============================================================ */

function stopBacktest() {
    if (!state.running) {
        log(
            "No backtest is currently running."
        );

        return;
    }

    state.stopRequested =
        true;

    setStatus(
        "Stopping..."
    );

    log(
        "Backtest stop requested."
    );
}


/* ============================================================
   WINDOW RESIZE
   ============================================================ */

function handleResize() {
    renderEquityCurve();
}


/* ============================================================
   EVENT BINDING
   ============================================================ */

function bindEvents() {
    const runButton =
        $("runBacktest");

    if (runButton) {
        runButton.addEventListener(
            "click",
            runBacktest
        );
    }

    const stopButton =
        $("stopBacktest");

    if (stopButton) {
        stopButton.addEventListener(
            "click",
            stopBacktest
        );
    }

    const clearButton =
        $("clearConsole");

    if (clearButton) {
        clearButton.addEventListener(
            "click",
            clearConsole
        );
    }

    window.addEventListener(
        "resize",
        handleResize
    );
}


/* ============================================================
   INITIAL UI
   ============================================================ */

function initializeUI() {
    if ($("market")) {
        $("market").value =
            DEFAULT_MARKET;
    }

    if ($("timeframe")) {
        $("timeframe").value =
            DEFAULT_TIMEFRAME;
    }

    if ($("candles")) {
        $("candles").value =
            String(
                DEFAULT_CANDLES
            );
    }

    if ($("warmup")) {
        $("warmup").value =
            String(
                DEFAULT_WARMUP
            );
    }

    if ($("forwardBars")) {
        $("forwardBars").value =
            String(
                DEFAULT_FORWARD_BARS
            );
    }

    setText(
        "summaryEngine",
        getEngineName()
    );

    renderStats();
    renderConsistency();
    renderStrategyTable();
    renderTradeLog();
    renderDiagnostics();
}


/* ============================================================
   STARTUP
   ============================================================ */

document.addEventListener(
    "DOMContentLoaded",
    () => {
        try {
            bindEvents();
            initializeUI();

            log(
                "Backtester 4.0.0-INTRADAY-CLEAN initialized."
            );

            log(
                `AI Engine: ${getEngineName()}`
            );

            log(
                `Default trade horizon: ${DEFAULT_FORWARD_BARS} ${DEFAULT_TIMEFRAME} candles = ${formatDurationBars(DEFAULT_FORWARD_BARS, DEFAULT_TIMEFRAME)}`
            );

            log(
                `A+ mode: score >= ${A_PLUS_SCORE}, confirmations >= ${A_PLUS_CONFIRMATIONS}, R:R >= ${A_PLUS_RR}.`
            );

            log(
                "Overlapping A+ trades are blocked."
            );

        } catch (error) {
            console.error(error);

            log(
                `Initialization error: ${error.message}`,
                "error"
            );
        }
    }
);


/* ============================================================
   GLOBAL EXPORTS
   ============================================================ */

window.Backtester = {
    state,

    runBacktest,
    stopBacktest,

    loadHistoricalData,

    analyzeHistorical,

    simulateTrade,

    calculateStats,

    renderStats,
    renderSummary,
    renderConsistency,
    renderStrategyTable,
    renderTradeLog,
    renderDiagnostics,
    renderEquityCurve
};