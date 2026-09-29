/* ============================================================
   AI ENGINE 3.3.0 - HIGH CONFLUENCE
   Market Drivers / A+ Backtest Engine

   Markets:
   XAUUSD
   USTEC
   BTCUSD

   Core:
   Liquidity
   Market Structure
   Auction / Profile
   VWAP
   Volume
   Volatility
   Multi-factor confluence

   IMPORTANT:
   - Historical analysis receives ONLY candles available
     at that historical point.
   - No future candles are used by analyze().
   - Backtest simulation is handled separately.
   ============================================================ */

(function (window) {

    "use strict";

    /* ============================================================
       ENGINE INFORMATION
       ============================================================ */

    const ENGINE_VERSION = "3.3.0-high-confluence";

    const STRICT_MIN_BARS = 80;
    const STRICT_MIN_RR = 1.25;
    const MIN_SCORE = 82;
    const MIN_CONFIRMATIONS = 4;

    const STRATEGY_NAMES = [
        "Liquidity Sweep",
        "Break of Structure",
        "Market Structure Shift",
        "Fair Value Gap",
        "Order Block",
        "Equal High / Low Sweep",
        "Previous High / Low Sweep",
        "Session Liquidity",
        "Auction Breakout",
        "Auction Rejection",
        "VAH Acceptance",
        "VAL Acceptance",
        "POC Rejection",
        "VWAP Reclaim",
        "VWAP Rejection",
        "Volume Expansion",
        "Compression Expansion",
        "Trend Continuation",
        "Mean Reversion",
        "Confluence Continuation"
    ];

    /* ============================================================
       BASIC UTILITIES
       ============================================================ */

    function number(value, fallback = NaN) {

        const n = Number(value);

        return Number.isFinite(n)
            ? n
            : fallback;
    }

    function clamp(value, min, max) {

        return Math.max(
            min,
            Math.min(max, value)
        );

    }

    function round(value, decimals = 2) {

        if (!Number.isFinite(value)) {
            return value;
        }

        const factor = Math.pow(10, decimals);

        return Math.round(value * factor) / factor;

    }

    function safeArray(value) {

        return Array.isArray(value)
            ? value
            : [];

    }

    function getOpen(bar) {

        return number(
            bar && (
                bar.open ??
                bar.o
            )
        );

    }

    function getHigh(bar) {

        return number(
            bar && (
                bar.high ??
                bar.h
            )
        );

    }

    function getLow(bar) {

        return number(
            bar && (
                bar.low ??
                bar.l
            )
        );

    }

    function getClose(bar) {

        return number(
            bar && (
                bar.close ??
                bar.c
            )
        );

    }

    function getVolume(bar) {

        return number(
            bar && (
                bar.volume ??
                bar.tickVolume ??
                bar.v
            ),
            0
        );

    }

    function validBar(bar) {

        return (
            Number.isFinite(getOpen(bar)) &&
            Number.isFinite(getHigh(bar)) &&
            Number.isFinite(getLow(bar)) &&
            Number.isFinite(getClose(bar))
        );

    }

    /* ============================================================
       DATA NORMALIZATION
       ============================================================ */

    function normalizeBar(bar) {

        if (!bar || typeof bar !== "object") {
            return null;
        }

        const open = getOpen(bar);
        const high = getHigh(bar);
        const low = getLow(bar);
        const close = getClose(bar);
        const volume = getVolume(bar);

        if (
            !Number.isFinite(open) ||
            !Number.isFinite(high) ||
            !Number.isFinite(low) ||
            !Number.isFinite(close)
        ) {
            return null;
        }

        let timestamp =
            bar.timestamp ??
            bar.openTime ??
            bar.time ??
            bar.date;

        if (typeof timestamp === "string") {

            const parsed =
                new Date(timestamp).getTime();

            if (Number.isFinite(parsed)) {
                timestamp = parsed;
            }

        }

        timestamp =
            number(timestamp, Date.now());

        return {

            ...bar,

            open,
            high,
            low,
            close,
            volume,
            timestamp

        };

    }

    function normalizeBars(bars) {

        return safeArray(bars)
            .map(normalizeBar)
            .filter(Boolean)
            .sort(
                (a, b) =>
                    a.timestamp - b.timestamp
            );

    }

    /* ============================================================
       SERIES HELPERS
       ============================================================ */

    function closes(bars) {

        return safeArray(bars)
            .map(getClose)
            .filter(Number.isFinite);

    }

    function highs(bars) {

        return safeArray(bars)
            .map(getHigh)
            .filter(Number.isFinite);

    }

    function lows(bars) {

        return safeArray(bars)
            .map(getLow)
            .filter(Number.isFinite);

    }

    function highest(bars, length = 20) {

        const data =
            safeArray(bars).slice(-length);

        if (!data.length) {
            return NaN;
        }

        return Math.max(
            ...data.map(getHigh)
        );

    }

    function lowest(bars, length = 20) {

        const data =
            safeArray(bars).slice(-length);

        if (!data.length) {
            return NaN;
        }

        return Math.min(
            ...data.map(getLow)
        );

    }

    function average(values) {

        const valid =
            safeArray(values)
                .filter(Number.isFinite);

        if (!valid.length) {
            return NaN;
        }

        return (
            valid.reduce(
                (sum, value) =>
                    sum + value,
                0
            ) / valid.length
        );

    }

    function SMA(bars, period = 20) {

        const data =
            closes(bars);

        if (data.length < period) {
            return NaN;
        }

        return average(
            data.slice(-period)
        );

    }

    function EMA(bars, period = 20) {

        const data =
            closes(bars);

        if (data.length < period) {
            return NaN;
        }

        const multiplier =
            2 / (period + 1);

        let ema =
            average(
                data.slice(0, period)
            );

        for (
            let i = period;
            i < data.length;
            i++
        ) {

            ema =
                (
                    data[i] - ema
                ) * multiplier + ema;

        }

        return ema;

    }

    function ATR(bars, period = 14) {

        if (bars.length < period + 1) {
            return NaN;
        }

        const trueRanges = [];

        for (
            let i = 1;
            i < bars.length;
            i++
        ) {

            const current = bars[i];
            const previous = bars[i - 1];

            const h = getHigh(current);
            const l = getLow(current);
            const pc = getClose(previous);

            if (
                !Number.isFinite(h) ||
                !Number.isFinite(l) ||
                !Number.isFinite(pc)
            ) {
                continue;
            }

            trueRanges.push(
                Math.max(
                    h - l,
                    Math.abs(h - pc),
                    Math.abs(l - pc)
                )
            );

        }

        if (trueRanges.length < period) {
            return NaN;
        }

        return average(
            trueRanges.slice(-period)
        );

    }

    /* ============================================================
       VWAP
       ============================================================ */

    function VWAP(bars) {

        let cumulativePV = 0;
        let cumulativeVolume = 0;

        for (const bar of bars) {

            const h = getHigh(bar);
            const l = getLow(bar);
            const c = getClose(bar);
            const v = getVolume(bar);

            if (
                !Number.isFinite(h) ||
                !Number.isFinite(l) ||
                !Number.isFinite(c)
            ) {
                continue;
            }

            const typical =
                (h + l + c) / 3;

            const volume =
                Number.isFinite(v) && v > 0
                    ? v
                    : 1;

            cumulativePV +=
                typical * volume;

            cumulativeVolume +=
                volume;

        }

        if (!cumulativeVolume) {
            return NaN;
        }

        return (
            cumulativePV /
            cumulativeVolume
        );

    }

    /* ============================================================
       VOLUME PROFILE
       ============================================================ */

    function volumeProfile(
        bars,
        bins = 24
    ) {

        if (!bars.length) {

            return {
                poc: NaN,
                vah: NaN,
                val: NaN,
                high: NaN,
                low: NaN
            };

        }

        const high =
            Math.max(...highs(bars));

        const low =
            Math.min(...lows(bars));

        if (
            !Number.isFinite(high) ||
            !Number.isFinite(low) ||
            high <= low
        ) {

            return {
                poc: high,
                vah: high,
                val: low,
                high,
                low
            };

        }

        const size =
            (high - low) / bins;

        const profile =
            new Array(bins)
                .fill(0);

        for (const bar of bars) {

            const h = getHigh(bar);
            const l = getLow(bar);
            const c = getClose(bar);

            if (
                !Number.isFinite(h) ||
                !Number.isFinite(l) ||
                !Number.isFinite(c)
            ) {
                continue;
            }

            const index =
                clamp(
                    Math.floor(
                        (c - low) / size
                    ),
                    0,
                    bins - 1
                );

            profile[index] +=
                Math.max(
                    1,
                    getVolume(bar)
                );

        }

        let pocIndex = 0;

        for (
            let i = 1;
            i < profile.length;
            i++
        ) {

            if (
                profile[i] >
                profile[pocIndex]
            ) {
                pocIndex = i;
            }

        }

        const poc =
            low +
            (pocIndex + 0.5) * size;

        const totalVolume =
            profile.reduce(
                (a, b) => a + b,
                0
            );

        const target =
            totalVolume * 0.70;

        let accumulated =
            profile[pocIndex];

        let left =
            pocIndex;

        let right =
            pocIndex;

        while (
            accumulated < target &&
            (
                left > 0 ||
                right < bins - 1
            )
        ) {

            const leftVolume =
                left > 0
                    ? profile[left - 1]
                    : -1;

            const rightVolume =
                right < bins - 1
                    ? profile[right + 1]
                    : -1;

            if (
                rightVolume >=
                leftVolume
            ) {

                if (right < bins - 1) {
                    right++;
                    accumulated +=
                        profile[right];
                } else {
                    left--;
                    accumulated +=
                        profile[left];
                }

            } else {

                if (left > 0) {
                    left--;
                    accumulated +=
                        profile[left];
                } else {
                    right++;
                    accumulated +=
                        profile[right];
                }

            }

        }

        return {

            poc,

            vah:
                low +
                (right + 1) * size,

            val:
                low +
                left * size,

            high,
            low,

            bins,
            profile

        };

    }

    /* ============================================================
       MARKET STRUCTURE
       ============================================================ */

    function structureDirection(bars) {

        if (bars.length < 20) {
            return "NEUTRAL";
        }

        const recent =
            bars.slice(-10);

        const previous =
            bars.slice(-20, -10);

        const recentHigh =
            Math.max(...highs(recent));

        const previousHigh =
            Math.max(...highs(previous));

        const recentLow =
            Math.min(...lows(recent));

        const previousLow =
            Math.min(...lows(previous));

        if (
            recentHigh > previousHigh &&
            recentLow > previousLow
        ) {
            return "BULLISH";
        }

        if (
            recentHigh < previousHigh &&
            recentLow < previousLow
        ) {
            return "BEARISH";
        }

        return "RANGE";

    }

    function detectBOS(bars) {

        if (bars.length < 15) {
            return "NONE";
        }

        const current =
            bars[bars.length - 1];

        const previous =
            bars.slice(-11, -1);

        const high =
            Math.max(...highs(previous));

        const low =
            Math.min(...lows(previous));

        if (
            getClose(current) > high
        ) {
            return "BULLISH";
        }

        if (
            getClose(current) < low
        ) {
            return "BEARISH";
        }

        return "NONE";

    }

    function detectMSS(bars) {

        if (bars.length < 25) {
            return "NONE";
        }

        const recent =
            bars.slice(-5);

        const before =
            bars.slice(-20, -5);

        const recentClose =
            getClose(
                recent[recent.length - 1]
            );

        const beforeHigh =
            Math.max(...highs(before));

        const beforeLow =
            Math.min(...lows(before));

        if (
            recentClose > beforeHigh
        ) {
            return "BULLISH";
        }

        if (
            recentClose < beforeLow
        ) {
            return "BEARISH";
        }

        return "NONE";

    }

    /* ============================================================
       LIQUIDITY
       ============================================================ */

    function detectLiquiditySweep(bars) {

        if (bars.length < 12) {
            return {
                direction: "NONE",
                level: NaN
            };
        }

        const current =
            bars[bars.length - 1];

        const previous =
            bars.slice(-11, -1);

        const priorHigh =
            Math.max(...highs(previous));

        const priorLow =
            Math.min(...lows(previous));

        const h =
            getHigh(current);

        const l =
            getLow(current);

        const c =
            getClose(current);

        if (
            h > priorHigh &&
            c < priorHigh
        ) {

            return {
                direction: "BEARISH",
                level: priorHigh
            };

        }

        if (
            l < priorLow &&
            c > priorLow
        ) {

            return {
                direction: "BULLISH",
                level: priorLow
            };

        }

        return {
            direction: "NONE",
            level: NaN
        };

    }

    function detectEqualHighLow(bars) {

        if (bars.length < 20) {
            return {
                high: NaN,
                low: NaN
            };
        }

        const data =
            bars.slice(-20);

        const tolerance =
            (
                Math.max(...highs(data)) -
                Math.min(...lows(data))
            ) * 0.002;

        const recentHigh =
            getHigh(
                data[data.length - 1]
            );

        const recentLow =
            getLow(
                data[data.length - 1]
            );

        let equalHigh = NaN;
        let equalLow = NaN;

        for (
            let i = 0;
            i < data.length - 3;
            i++
        ) {

            if (
                Math.abs(
                    getHigh(data[i]) -
                    recentHigh
                ) <= tolerance
            ) {
                equalHigh = recentHigh;
            }

            if (
                Math.abs(
                    getLow(data[i]) -
                    recentLow
                ) <= tolerance
            ) {
                equalLow = recentLow;
            }

        }

        return {
            high: equalHigh,
            low: equalLow
        };

    }

    /* ============================================================
       FVG DETECTION
       ============================================================ */

    function detectFVG(bars) {

        if (bars.length < 5) {
            return {
                direction: "NONE",
                high: NaN,
                low: NaN
            };
        }

        const a =
            bars[bars.length - 3];

        const c =
            bars[bars.length - 1];

        if (
            getLow(c) >
            getHigh(a)
        ) {

            return {
                direction: "BULLISH",
                low: getHigh(a),
                high: getLow(c)
            };

        }

        if (
            getHigh(c) <
            getLow(a)
        ) {

            return {
                direction: "BEARISH",
                low: getHigh(c),
                high: getLow(a)
            };

        }

        return {
            direction: "NONE",
            high: NaN,
            low: NaN
        };

    }

    /* ============================================================
       VOLUME ANALYSIS
       ============================================================ */

    function volumeExpansion(bars) {

        if (bars.length < 21) {
            return "NONE";
        }

        const current =
            getVolume(
                bars[bars.length - 1]
            );

        const averageVolume =
            average(
                bars
                    .slice(-21, -1)
                    .map(getVolume)
            );

        if (
            !Number.isFinite(current) ||
            !Number.isFinite(averageVolume) ||
            averageVolume <= 0
        ) {
            return "NONE";
        }

        if (
            current >=
            averageVolume * 1.5
        ) {

            const currentClose =
                getClose(
                    bars[bars.length - 1]
                );

            const previousClose =
                getClose(
                    bars[bars.length - 2]
                );

            if (
                currentClose >
                previousClose
            ) {
                return "BULLISH";
            }

            if (
                currentClose <
                previousClose
            ) {
                return "BEARISH";
            }

        }

        return "NONE";

    }

    /* ============================================================
       COMPRESSION
       ============================================================ */

    function compressionState(bars) {

        if (bars.length < 30) {
            return false;
        }

        const shortRange =
            highest(bars, 8) -
            lowest(bars, 8);

        const longRange =
            highest(bars, 30) -
            lowest(bars, 30);

        if (
            !Number.isFinite(shortRange) ||
            !Number.isFinite(longRange) ||
            longRange <= 0
        ) {
            return false;
        }

        return (
            shortRange /
            longRange
        ) <= 0.45;

    }

    /* ============================================================
       REGIME
       ============================================================ */

    function marketRegime(bars) {

        if (bars.length < 40) {
            return "INSUFFICIENT_DATA";
        }

        const atr =
            ATR(bars, 14);

        const range =
            highest(bars, 20) -
            lowest(bars, 20);

        const ema20 =
            EMA(bars, 20);

        const ema50 =
            EMA(bars, 50);

        const close =
            getClose(
                bars[bars.length - 1]
            );

        if (
            !Number.isFinite(atr) ||
            !Number.isFinite(range)
        ) {
            return "UNKNOWN";
        }

        if (
            compressionState(bars)
        ) {
            return "COMPRESSION";
        }

        if (
            Number.isFinite(ema20) &&
            Number.isFinite(ema50) &&
            close > ema20 &&
            ema20 > ema50
        ) {
            return "BULLISH_TREND";
        }

        if (
            Number.isFinite(ema20) &&
            Number.isFinite(ema50) &&
            close < ema20 &&
            ema20 < ema50
        ) {
            return "BEARISH_TREND";
        }

        if (
            range <= atr * 5
        ) {
            return "BALANCE";
        }

        return "TRANSITION";

    }

    /* ============================================================
       CANDIDATE CREATION
       ============================================================ */

    function makeCandidate(options) {

        const {

            symbol,
            direction,
            entry,
            stop,
            target,
            strategy,
            score,
            confirmations,
            reason,
            invalidation,
            entryZone,
            bias

        } = options;

        if (
            !symbol ||
            !direction ||
            !Number.isFinite(entry) ||
            !Number.isFinite(stop) ||
            !Number.isFinite(target)
        ) {
            return null;
        }

        const risk =
            Math.abs(
                entry - stop
            );

        if (
            risk <= 0
        ) {
            return null;
        }

        const reward =
            Math.abs(
                target - entry
            );

        const rr =
            reward / risk;

        const finalScore =
            clamp(
                number(score, 0),
                0,
                100
            );

        const finalConfirmations =
            Math.max(
                0,
                Math.floor(
                    number(
                        confirmations,
                        0
                    )
                )
            );

        const passed =
            finalScore >= MIN_SCORE &&
            finalConfirmations >=
                MIN_CONFIRMATIONS &&
            rr >= STRICT_MIN_RR;

        return {

            symbol,

            direction,

            bias:
                bias ||
                direction,

            entry,

            stop,

            target,

            tp1: target,

            tp2: target,

            risk,

            reward,

            rr,

            score:
                round(
                    finalScore,
                    2
                ),

            confirmations:
                finalConfirmations,

            grade:
                passed
                    ? "A+"
                    : "WAIT",

            status:
                passed
                    ? "A+"
                    : "WAIT",

            strictPass:
                passed,

            valid:
                passed,

            strategy:
                strategy ||
                "Confluence Continuation",

            strategyName:
                strategy ||
                "Confluence Continuation",

            reason:
                reason ||
                "Insufficient confluence.",

            invalidation:
                invalidation ||
                "Setup invalidated if stop is reached.",

            entryZone:
                entryZone ||
                {
                    low:
                        Math.min(
                            entry,
                            stop
                        ),
                    high:
                        Math.max(
                            entry,
                            stop
                        )
                },

            timestamp:
                Date.now()

        };

    }

    /* ============================================================
       CANDIDATE VALIDATION
       ============================================================ */

    function strictValidateCandidate(
        candidate,
        context
    ) {

        if (!candidate) {
            return null;
        }

        const risk =
            Math.abs(
                number(candidate.entry) -
                number(candidate.stop)
            );

        const reward =
            Math.abs(
                number(candidate.target) -
                number(candidate.entry)
            );

        const rr =
            risk > 0
                ? reward / risk
                : 0;

        const score =
            number(
                candidate.score,
                0
            );

        const confirmations =
            Math.floor(
                number(
                    candidate.confirmations,
                    0
                )
            );

        const validDirection =
            candidate.direction ===
                "LONG" ||
            candidate.direction ===
                "SHORT";

        const direction =
            candidate.direction;

        let geometryValid = false;

        if (
            direction === "LONG"
        ) {

            geometryValid =
                candidate.stop <
                    candidate.entry &&
                candidate.target >
                    candidate.entry;

        } else if (
            direction === "SHORT"
        ) {

            geometryValid =
                candidate.stop >
                    candidate.entry &&
                candidate.target <
                    candidate.entry;

        }

        const strictPass =
            validDirection &&
            geometryValid &&
            score >= MIN_SCORE &&
            confirmations >=
                MIN_CONFIRMATIONS &&
            rr >= STRICT_MIN_RR;

        return {

            ...candidate,

            rr:

                round(
                    rr,
                    2
                ),

            score:

                round(
                    score,
                    2
                ),

            confirmations,

            strictPass,

            valid:
                strictPass,

            grade:
                strictPass
                    ? "A+"
                    : "WAIT",

            status:
                strictPass
                    ? "A+"
                    : "WAIT"

        };

    }

    function validateCandidate(
        candidate,
        context
    ) {

        return strictValidateCandidate(
            candidate,
            context
        );

    }

    /* ============================================================
       CANDIDATE GENERATION
       ============================================================ */

    function generateCandidate(
        symbol,
        bars
    ) {

        if (
            !Array.isArray(bars) ||
            bars.length <
                STRICT_MIN_BARS
        ) {
            return null;
        }

        const current =
            bars[bars.length - 1];

        const close =
            getClose(current);

        const atr =
            ATR(bars, 14);

        if (
            !Number.isFinite(close) ||
            !Number.isFinite(atr) ||
            atr <= 0
        ) {
            return null;
        }

        const structure =
            structureDirection(bars);

        const bos =
            detectBOS(bars);

        const mss =
            detectMSS(bars);

        const sweep =
            detectLiquiditySweep(bars);

        const fvg =
            detectFVG(bars);

        const profile =
            volumeProfile(
                bars.slice(-80),
                24
            );

        const vwap =
            VWAP(
                bars.slice(-80)
            );

        const ema20 =
            EMA(bars, 20);

        const ema50 =
            EMA(bars, 50);

        const volume =
            volumeExpansion(bars);

        const regime =
            marketRegime(bars);

        const compression =
            compressionState(bars);

        let longScore = 0;
        let shortScore = 0;

        let longConfirmations = 0;
        let shortConfirmations = 0;

        const longReasons = [];
        const shortReasons = [];

        /* --------------------------------------------------------
           STRUCTURE
           -------------------------------------------------------- */

        if (
            structure === "BULLISH"
        ) {

            longScore += 15;
            longConfirmations++;

            longReasons.push(
                "Bullish market structure"
            );

        }

        if (
            structure === "BEARISH"
        ) {

            shortScore += 15;
            shortConfirmations++;

            shortReasons.push(
                "Bearish market structure"
            );

        }

        if (
            bos === "BULLISH"
        ) {

            longScore += 15;
            longConfirmations++;

            longReasons.push(
                "Bullish break of structure"
            );

        }

        if (
            bos === "BEARISH"
        ) {

            shortScore += 15;
            shortConfirmations++;

            shortReasons.push(
                "Bearish break of structure"
            );

        }

        if (
            mss === "BULLISH"
        ) {

            longScore += 18;
            longConfirmations++;

            longReasons.push(
                "Bullish market structure shift"
            );

        }

        if (
            mss === "BEARISH"
        ) {

            shortScore += 18;
            shortConfirmations++;

            shortReasons.push(
                "Bearish market structure shift"
            );

        }

        /* --------------------------------------------------------
           LIQUIDITY
           -------------------------------------------------------- */

        if (
            sweep.direction ===
            "BULLISH"
        ) {

            longScore += 20;
            longConfirmations++;

            longReasons.push(
                "Sell-side liquidity sweep and rejection"
            );

        }

        if (
            sweep.direction ===
            "BEARISH"
        ) {

            shortScore += 20;
            shortConfirmations++;

            shortReasons.push(
                "Buy-side liquidity sweep and rejection"
            );

        }

        /* --------------------------------------------------------
           FVG
           -------------------------------------------------------- */

        if (
            fvg.direction ===
            "BULLISH"
        ) {

            longScore += 8;
            longConfirmations++;

            longReasons.push(
                "Bullish fair value gap"
            );

        }

        if (
            fvg.direction ===
            "BEARISH"
        ) {

            shortScore += 8;
            shortConfirmations++;

            shortReasons.push(
                "Bearish fair value gap"
            );

        }

        /* --------------------------------------------------------
           VWAP
           -------------------------------------------------------- */

        if (
            Number.isFinite(vwap)
        ) {

            if (
                close > vwap
            ) {

                longScore += 8;
                longConfirmations++;

                longReasons.push(
                    "Price above VWAP"
                );

            }

            if (
                close < vwap
            ) {

                shortScore += 8;
                shortConfirmations++;

                shortReasons.push(
                    "Price below VWAP"
                );

            }

        }

        /* --------------------------------------------------------
           EMA TREND
           -------------------------------------------------------- */

        if (
            Number.isFinite(ema20) &&
            Number.isFinite(ema50)
        ) {

            if (
                ema20 > ema50 &&
                close > ema20
            ) {

                longScore += 8;
                longConfirmations++;

                longReasons.push(
                    "Bullish EMA alignment"
                );

            }

            if (
                ema20 < ema50 &&
                close < ema20
            ) {

                shortScore += 8;
                shortConfirmations++;

                shortReasons.push(
                    "Bearish EMA alignment"
                );

            }

        }

        /* --------------------------------------------------------
           PROFILE
           -------------------------------------------------------- */

        if (
            Number.isFinite(profile.poc)
        ) {

            if (
                close > profile.poc
            ) {

                longScore += 6;

                longReasons.push(
                    "Price accepted above profile POC"
                );

            }

            if (
                close < profile.poc
            ) {

                shortScore += 6;

                shortReasons.push(
                    "Price accepted below profile POC"
                );

            }

        }

        if (
            Number.isFinite(profile.vah) &&
            close > profile.vah
        ) {

            longScore += 7;
            longConfirmations++;

            longReasons.push(
                "Acceptance above value area high"
            );

        }

        if (
            Number.isFinite(profile.val) &&
            close < profile.val
        ) {

            shortScore += 7;
            shortConfirmations++;

            shortReasons.push(
                "Acceptance below value area low"
            );

        }

        /* --------------------------------------------------------
           VOLUME
           -------------------------------------------------------- */

        if (
            volume === "BULLISH"
        ) {

            longScore += 8;
            longConfirmations++;

            longReasons.push(
                "Bullish volume expansion"
            );

        }

        if (
            volume === "BEARISH"
        ) {

            shortScore += 8;
            shortConfirmations++;

            shortReasons.push(
                "Bearish volume expansion"
            );

        }

        /* --------------------------------------------------------
           COMPRESSION / EXPANSION
           -------------------------------------------------------- */

        if (
            compression &&
            structure === "BULLISH"
        ) {

            longScore += 5;

            longReasons.push(
                "Compression with bullish expansion potential"
            );

        }

        if (
            compression &&
            structure === "BEARISH"
        ) {

            shortScore += 5;

            shortReasons.push(
                "Compression with bearish expansion potential"
            );

        }

        /* --------------------------------------------------------
           REGIME BONUS
           -------------------------------------------------------- */

        if (
            regime === "BULLISH_TREND"
        ) {

            longScore += 5;

        }

        if (
            regime === "BEARISH_TREND"
        ) {

            shortScore += 5;

        }

        /* --------------------------------------------------------
           DETERMINE DIRECTION
           -------------------------------------------------------- */

        let direction;

        if (
            longScore >
            shortScore
        ) {

            direction = "LONG";

        } else if (
            shortScore >
            longScore
        ) {

            direction = "SHORT";

        } else {

            return null;

        }

        const score =
            direction === "LONG"
                ? longScore
                : shortScore;

        const confirmations =
            direction === "LONG"
                ? longConfirmations
                : shortConfirmations;

        /* --------------------------------------------------------
           STOP / TARGET
           -------------------------------------------------------- */

        let stop;
        let target;

        if (
            direction === "LONG"
        ) {

            const liquidityLow =
                Number.isFinite(
                    sweep.level
                )
                    ? sweep.level
                    : lowest(
                        bars.slice(-20),
                        20
                    );

            stop =
                Math.min(
                    liquidityLow,
                    close - atr * 1.25
                );

            if (
                stop >= close
            ) {
                stop =
                    close -
                    atr * 1.25;
            }

            const risk =
                close - stop;

            target =
                close +
                Math.max(
                    risk * 2,
                    atr * 2
                );

        } else {

            const liquidityHigh =
                Number.isFinite(
                    sweep.level
                )
                    ? sweep.level
                    : highest(
                        bars.slice(-20),
                        20
                    );

            stop =
                Math.max(
                    liquidityHigh,
                    close + atr * 1.25
                );

            if (
                stop <= close
            ) {
                stop =
                    close +
                    atr * 1.25;
            }

            const risk =
                stop - close;

            target =
                close -
                Math.max(
                    risk * 2,
                    atr * 2
                );

        }

        const strategy =
            sweep.direction !== "NONE"
                ? "Liquidity Sweep"
                : bos !== "NONE"
                    ? "Break of Structure"
                    : mss !== "NONE"
                        ? "Market Structure Shift"
                        : volume !== "NONE"
                            ? "Volume Expansion"
                            : "Confluence Continuation";

        const reasons =
            direction === "LONG"
                ? longReasons
                : shortReasons;

        const candidate =
            makeCandidate({

                symbol,

                direction,

                entry:
                    close,

                stop,

                target,

                strategy,

                score,

                confirmations,

                reason:
                    reasons.join(
                        " • "
                    ),

                invalidation:
                    direction === "LONG"
                        ? "Bullish thesis invalid below stop/liquidity structure."
                        : "Bearish thesis invalid above stop/liquidity structure.",

                entryZone: {

                    low:
                        direction === "LONG"
                            ? close - atr * 0.20
                            : close - atr * 0.10,

                    high:
                        direction === "LONG"
                            ? close + atr * 0.10
                            : close + atr * 0.20

                },

                bias:
                    direction

            });

        return candidate;

    }

    /* ============================================================
       ANALYZE
       ============================================================ */

    function analyze(
        symbol,
        bars
    ) {

        if (
            !Array.isArray(bars) ||
            bars.length <
                STRICT_MIN_BARS
        ) {

            return {

                valid: false,

                symbol,

                setup: null,

                best: null,

                candidates: [],

                allCandidates: [],

                status: "WAIT",

                grade: "WAIT",

                reason:
                    "Insufficient historical data",

                regime:
                    "INSUFFICIENT_DATA"

            };

        }

        const normalized =
            normalizeBars(bars);

        if (
            normalized.length <
            STRICT_MIN_BARS
        ) {

            return {

                valid: false,

                symbol,

                setup: null,

                best: null,

                candidates: [],

                allCandidates: [],

                status: "WAIT",

                grade: "WAIT",

                reason:
                    "Insufficient valid candles",

                regime:
                    "INSUFFICIENT_DATA"

            };

        }

        const candidate =
            generateCandidate(
                symbol,
                normalized
            );

        if (!candidate) {

            return {

                valid: true,

                symbol,

                setup: null,

                best: null,

                candidates: [],

                allCandidates: [],

                status: "WAIT",

                grade: "WAIT",

                reason:
                    "No valid high-confluence setup.",

                regime:
                    marketRegime(
                        normalized
                    )

            };

        }

        const validated =
            strictValidateCandidate(
                candidate,
                {
                    symbol,
                    bars:
                        normalized
                }
            );

        const setup =
            validated &&
            validated.strictPass
                ? validated
                : null;

        return {

            valid: true,

            symbol,

            setup,

            best:
                setup,

            candidates:
                setup
                    ? [setup]
                    : [],

            allCandidates:
                [validated],

            status:
                setup
                    ? "A+"
                    : "WAIT",

            grade:
                setup
                    ? "A+"
                    : "WAIT",

            score:
                validated
                    ? validated.score
                    : 0,

            confirmations:
                validated
                    ? validated.confirmations
                    : 0,

            reason:
                setup
                    ? validated.reason
                    : (
                        validated
                            ? "Setup did not meet all A+ requirements."
                            : "No valid candidate."
                    ),

            regime:
                marketRegime(
                    normalized
                )

        };

    }

    /* ============================================================
       HISTORICAL ANALYSIS
       ============================================================

       IMPORTANT:
       The backtester supplies only candles available at
       the historical point being tested.

       Do NOT add an index parameter here.
       ============================================================ */

    function analyzeHistorical(
        symbol,
        bars
    ) {

        return analyze(
            symbol,
            bars
        );

    }

    /* ============================================================
       STRATEGY RUNNER
       ============================================================ */

    function runStrategies(
        symbol,
        bars
    ) {

        const analysis =
            analyze(
                symbol,
                bars
            );

        if (
            !analysis ||
            !analysis.setup
        ) {

            return [];

        }

        return [
            analysis.setup
        ];

    }

    /* ============================================================
       CANDIDATE SCORING
       ============================================================ */

    function scoreCandidate(
        candidate,
        context
    ) {

        return strictValidateCandidate(
            candidate,
            context
        );

    }

    /* ============================================================
       TRADE SIMULATION
       ============================================================ */

    function simulateTrade(
        candidate,
        futureBars
    ) {

        if (
            !candidate ||
            !Array.isArray(futureBars) ||
            !futureBars.length
        ) {

            return {

                result: "OPEN",

                exit: null,

                r: 0,

                barsHeld: 0

            };

        }

        const entry =
            number(
                candidate.entry
            );

        const stop =
            number(
                candidate.stop
            );

        const target =
            number(
                candidate.target ??
                candidate.tp1
            );

        const direction =
            candidate.direction;

        const risk =
            Math.abs(
                entry - stop
            );

        if (
            risk <= 0
        ) {

            return {

                result: "OPEN",

                exit: null,

                r: 0,

                barsHeld: 0

            };

        }

        for (
            let i = 0;
            i < futureBars.length;
            i++
        ) {

            const bar =
                futureBars[i];

            const high =
                getHigh(bar);

            const low =
                getLow(bar);

            if (
                !Number.isFinite(high) ||
                !Number.isFinite(low)
            ) {
                continue;
            }

            if (
                direction === "LONG"
            ) {

                const stopHit =
                    low <= stop;

                const targetHit =
                    high >= target;

                /* ----------------------------------------------
                   Stop-first rule when both levels are touched
                   inside the same candle.
                   ---------------------------------------------- */

                if (
                    stopHit
                ) {

                    return {

                        result: "LOSS",

                        exit:
                            stop,

                        r: -1,

                        barsHeld:
                            i + 1

                    };

                }

                if (
                    targetHit
                ) {

                    return {

                        result: "WIN",

                        exit:
                            target,

                        r:
                            (
                                target -
                                entry
                            ) / risk,

                        barsHeld:
                            i + 1

                    };

                }

            }

            if (
                direction === "SHORT"
            ) {

                const stopHit =
                    high >= stop;

                const targetHit =
                    low <= target;

                if (
                    stopHit
                ) {

                    return {

                        result: "LOSS",

                        exit:
                            stop,

                        r: -1,

                        barsHeld:
                            i + 1

                    };

                }

                if (
                    targetHit
                ) {

                    return {

                        result: "WIN",

                        exit:
                            target,

                        r:
                            (
                                entry -
                                target
                            ) / risk,

                        barsHeld:
                            i + 1

                    };

                }

            }

        }

        return {

            result: "OPEN",

            exit: null,

            r: 0,

            barsHeld:
                futureBars.length

        };

    }

    /* ============================================================
       BACKTEST ENGINE HELPER
       ============================================================ */

    function backtestBars(
        symbol,
        bars,
        options = {}
    ) {

        const warmup =
            Math.max(
                STRICT_MIN_BARS,
                number(
                    options.warmupBars,
                    STRICT_MIN_BARS
                )
            );

        const forward =
            Math.max(
                1,
                number(
                    options.forwardBars,
                    40
                )
            );

        const trades = [];

        for (
            let index = warmup;
            index <
            bars.length - forward;
            index++
        ) {

            const historicalBars =
                bars.slice(
                    0,
                    index + 1
                );

            const analysis =
                analyzeHistorical(
                    symbol,
                    historicalBars
                );

            if (
                !analysis ||
                !analysis.setup
            ) {
                continue;
            }

            const futureBars =
                bars.slice(
                    index + 1,
                    index + 1 + forward
                );

            const result =
                simulateTrade(
                    analysis.setup,
                    futureBars
                );

            if (
                result.result ===
                "OPEN"
            ) {
                continue;
            }

            trades.push({

                index,

                signalBar:
                    historicalBars[
                        historicalBars.length - 1
                    ],

                candidate:
                    analysis.setup,

                result:
                    result.result,

                r:
                    result.r,

                exit:
                    result.exit,

                barsHeld:
                    result.barsHeld

            });

        }

        return trades;

    }

    /* ============================================================
       ENGINE PUBLIC OBJECT
       ============================================================ */

    const AIEngine = {

        version:
            ENGINE_VERSION,

        engineVersion:
            ENGINE_VERSION,

        STRICT_MIN_BARS,

        STRICT_MIN_RR,

        MIN_SCORE,

        MIN_CONFIRMATIONS,

        STRATEGY_NAMES,

        strategies:
            STRATEGY_NAMES,

        engineInfo: {

            version:
                ENGINE_VERSION,

            strategies:
                STRATEGY_NAMES.length,

            minScore:
                MIN_SCORE,

            minConfirmations:
                MIN_CONFIRMATIONS,

            minRR:
                STRICT_MIN_RR,

            mode:
                "high-confluence",

            description:
                "Liquidity, structure, auction/profile, VWAP, volume and volatility confluence."

        },

        analyze,

        analyzeHistorical,

        runStrategies,

        scoreCandidate,

        validateCandidate,

        strictValidateCandidate,

        simulateTrade,

        backtestBars,

        marketRegime,

        structureDirection,

        volumeProfile,

        VWAP,

        EMA,

        SMA,

        ATR,

        highest,

        lowest,

        makeCandidate

    };

    /* ============================================================
       GLOBAL EXPORT
       ============================================================ */

    window.AIEngine =
        AIEngine;

    console.log(
        "AI Engine " +
        ENGINE_VERSION +
        " loaded."
    );

    console.log(
        STRATEGY_NAMES.length +
        " strategies active."
    );

    console.log(
        "A+ mode: high-confluence selection, realistic R:R, liquidity, structure, profile, VWAP and volatility filters."
    );

    console.log(
        "A+ requirements: score >= " +
        MIN_SCORE +
        ", confirmations >= " +
        MIN_CONFIRMATIONS +
        ", R:R >= " +
        STRICT_MIN_RR +
        "."
    );

})(window);