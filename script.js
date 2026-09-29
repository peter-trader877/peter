/* ============================================================
   MARKET DRIVERS AI DASHBOARD
   script.js
   Version: 4.0
   ============================================================ */

"use strict";

/* ============================================================
   CONFIGURATION
   ============================================================ */

const CONFIG = {
    API_BASE: "https://biquote.io/api",

    markets: [
        {
            symbol: "XAUUSD",
            name: "Gold",
            description: "Gold"
        },
        {
            symbol: "USTEC",
            name: "Nasdaq",
            description: "Nasdaq"
        },
        {
            symbol: "BTCUSD",
            name: "Bitcoin",
            description: "Bitcoin"
        },
        {
            symbol: "DXY",
            name: "US Dollar Index",
            description: "US Dollar Index"
        },
        {
            symbol: "USOIL",
            name: "Crude Oil",
            description: "Crude Oil"
        }
    ],

    analysisSymbols: [
        "XAUUSD",
        "USTEC",
        "BTCUSD"
    ],

    intervals: [
        "5m",
        "15m",
        "1h",
        "4h"
    ],

    liveInterval: "5m",

    liveLimit: 161,

    requestTimeout: 15000,

    refreshMs: 60000
};


/* ============================================================
   GLOBAL STATE
   ============================================================ */

const DashboardState = {
    markets: {},
    candles: {},
    analyses: {},
    lastUpdated: null,

    running: false,

    refreshTimer: null,
    clockTimer: null,

    logLines: []
};


/* ============================================================
   DOM HELPERS
   ============================================================ */

function $(id) {
    return document.getElementById(id);
}


function findElement(ids = [], selectors = []) {

    for (const id of ids) {

        const element = $(id);

        if (element) {
            return element;
        }
    }

    for (const selector of selectors) {

        try {

            const element =
                document.querySelector(selector);

            if (element) {
                return element;
            }

        } catch (error) {
            // Ignore invalid optional selectors.
        }
    }

    return null;
}


/* ============================================================
   LOGGING
   ============================================================ */

function log(message, type = "info") {

    const timestamp =
        new Date().toLocaleTimeString();

    const line =
        `[${timestamp}] ${message}`;

    DashboardState.logLines.push(line);

    if (DashboardState.logLines.length > 300) {
        DashboardState.logLines.shift();
    }

    console.log(
        `[MarketDrivers:${type}]`,
        message
    );

    const output = $("systemLog");

    if (output) {

        output.textContent =
            DashboardState.logLines.join("\n");

        output.scrollTop =
            output.scrollHeight;
    }
}


function clearLog() {

    DashboardState.logLines = [];

    const output = $("systemLog");

    if (output) {
        output.textContent = "";
    }
}


/* ============================================================
   TEXT / NUMBER HELPERS
   ============================================================ */

function safeNumber(value) {

    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    const number =
        Number(value);

    return Number.isFinite(number)
        ? number
        : null;
}


function formatPrice(value, symbol = "") {

    const number =
        safeNumber(value);

    if (number === null) {
        return "--";
    }

    if (symbol === "BTCUSD") {
        return number.toLocaleString(
            undefined,
            {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            }
        );
    }

    if (symbol === "USTEC") {
        return number.toLocaleString(
            undefined,
            {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            }
        );
    }

    return number.toLocaleString(
        undefined,
        {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }
    );
}


function formatPercent(value) {

    const number =
        safeNumber(value);

    if (number === null) {
        return "--";
    }

    return `${number.toFixed(2)}%`;
}


function formatChange(value) {

    const number =
        safeNumber(value);

    if (number === null) {
        return "--";
    }

    const sign =
        number > 0
            ? "+"
            : "";

    return `${sign}${number.toFixed(2)}`;
}


function escapeHTML(value) {

    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


/* ============================================================
   FETCH WITH TIMEOUT
   ============================================================ */

async function fetchJSON(
    url,
    timeout = CONFIG.requestTimeout
) {

    const controller =
        new AbortController();

    const timer =
        setTimeout(
            () => controller.abort(),
            timeout
        );

    try {

        const response =
            await fetch(
                url,
                {
                    method: "GET",
                    signal: controller.signal,
                    cache: "no-store",
                    headers: {
                        Accept:
                            "application/json"
                    }
                }
            );

        if (!response.ok) {

            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const contentType =
            response.headers
                .get("content-type") || "";

        if (
            !contentType
                .toLowerCase()
                .includes("application/json")
        ) {

            const text =
                await response.text();

            throw new Error(
                `Expected JSON but received: ${
                    text.slice(0, 100)
                }`
            );
        }

        return await response.json();

    } finally {

        clearTimeout(timer);
    }
}


/* ============================================================
   API PARSER
   ============================================================ */

function extractCandleArray(payload) {

    if (!payload) {
        return [];
    }

    if (Array.isArray(payload)) {
        return payload;
    }

    if (Array.isArray(payload.bars)) {
        return payload.bars;
    }

    if (
        payload.data &&
        Array.isArray(payload.data.bars)
    ) {
        return payload.data.bars;
    }

    if (
        payload.data &&
        Array.isArray(payload.data)
    ) {
        return payload.data;
    }

    if (Array.isArray(payload.results)) {
        return payload.results;
    }

    if (
        payload.data &&
        Array.isArray(payload.data.results)
    ) {
        return payload.data.results;
    }

    if (
        payload.result &&
        Array.isArray(payload.result)
    ) {
        return payload.result;
    }

    return [];
}


/* ============================================================
   CANDLE NORMALIZATION
   ============================================================ */

function normalizeCandle(candle) {

    if (!candle) {
        return null;
    }

    const timeValue =
        candle.openTime ??
        candle.timestamp ??
        candle.time ??
        candle.date ??
        candle.datetime;

    let timestamp;

    if (
        typeof timeValue === "number"
    ) {

        timestamp =
            timeValue < 10000000000
                ? timeValue * 1000
                : timeValue;

    } else {

        timestamp =
            Date.parse(timeValue);
    }

    if (!Number.isFinite(timestamp)) {
        return null;
    }

    const open =
        safeNumber(
            candle.open ??
            candle.o
        );

    const high =
        safeNumber(
            candle.high ??
            candle.h
        );

    const low =
        safeNumber(
            candle.low ??
            candle.l
        );

    const close =
        safeNumber(
            candle.close ??
            candle.c
        );

    const volume =
        safeNumber(
            candle.volume ??
            candle.v ??
            0
        ) ?? 0;

    if (
        open === null ||
        high === null ||
        low === null ||
        close === null
    ) {
        return null;
    }

    return {
        timestamp,
        time: timestamp,

        open,
        high,
        low,
        close,

        volume,

        isClosed:
            candle.isClosed ??
            candle.closed ??
            true
    };
}


function normalizeCandles(raw) {

    const candles =
        Array.isArray(raw)
            ? raw
                .map(normalizeCandle)
                .filter(Boolean)
            : [];

    candles.sort(
        (a, b) =>
            a.timestamp -
            b.timestamp
    );

    const unique = [];

    const seen =
        new Set();

    for (const candle of candles) {

        if (
            seen.has(
                candle.timestamp
            )
        ) {
            continue;
        }

        seen.add(
            candle.timestamp
        );

        unique.push(candle);
    }

    return unique;
}


/* ============================================================
   LOAD MARKET HISTORY
   ============================================================ */

async function loadMarketCandles(
    symbol,
    interval = CONFIG.liveInterval,
    limit = CONFIG.liveLimit
) {

    const url =
        `${CONFIG.API_BASE}/${encodeURIComponent(symbol)}` +
        `/ohlc?interval=${encodeURIComponent(interval)}` +
        `&limit=${encodeURIComponent(limit)}`;

    const payload =
        await fetchJSON(url);

    const raw =
        extractCandleArray(payload);

    const candles =
        normalizeCandles(raw);

    if (!candles.length) {

        throw new Error(
            `${symbol}: API returned no valid candles`
        );
    }

    return candles;
}


/* ============================================================
   MARKET SNAPSHOT
   ============================================================ */

function getMarketSnapshot(
    symbol,
    candles
) {

    if (
        !candles ||
        candles.length === 0
    ) {
        return null;
    }

    const last =
        candles[candles.length - 1];

    const previous =
        candles.length > 1
            ? candles[candles.length - 2]
            : null;

    const previousClose =
        previous
            ? previous.close
            : last.close;

    const change =
        previousClose
            ? (
                (
                    last.close -
                    previousClose
                ) /
                previousClose
            ) * 100
            : 0;

    return {
        symbol,

        price:
            last.close,

        open:
            last.open,

        high:
            last.high,

        low:
            last.low,

        volume:
            last.volume,

        previousClose,

        change,

        timestamp:
            last.timestamp
    };
}


/* ============================================================
   LIVE MARKET LOADING
   ============================================================ */

async function loadLiveMarkets() {

    log(
        "Loading live market data..."
    );

    const results = {};

    let successful = 0;

    for (
        const market
        of CONFIG.markets
    ) {

        try {

            const candles =
                await loadMarketCandles(
                    market.symbol,
                    CONFIG.liveInterval,
                    CONFIG.liveLimit
                );

            const snapshot =
                getMarketSnapshot(
                    market.symbol,
                    candles
                );

            DashboardState.candles[
                market.symbol
            ] = candles;

            DashboardState.markets[
                market.symbol
            ] = snapshot;

            results[
                market.symbol
            ] = snapshot;

            successful++;

            log(
                `${market.symbol}: ${candles.length} valid ${CONFIG.liveInterval} candles loaded.`
            );

        } catch (error) {

            log(
                `${market.symbol}: live data failed - ${error.message}`,
                "error"
            );
        }
    }

    DashboardState.lastUpdated =
        new Date();

    renderLiveMarkets();

    updateConnectionStatus(
        successful
    );

    return results;
}


/* ============================================================
   CONNECTION STATUS
   ============================================================ */

function updateConnectionStatus(
    successful
) {

    const element =
        $("connectionStatus");

    if (!element) {
        return;
    }

    if (
        successful ===
        CONFIG.markets.length
    ) {

        element.textContent =
            "Market Data: Live";

        element.classList.add(
            "online"
        );

    } else if (
        successful > 0
    ) {

        element.textContent =
            `Market Data: Partial (${successful}/${CONFIG.markets.length})`;

        element.classList.remove(
            "online"
        );

    } else {

        element.textContent =
            "Market Data: Offline";

        element.classList.remove(
            "online"
        );
    }
}


/* ============================================================
   LIVE MARKET CARDS
   ============================================================ */

function renderLiveMarkets() {

    const container =
        findElement(
            [
                "marketCards",
                "market-cards",
                "liveMarkets",
                "live-markets"
            ],
            [
                ".market-cards",
                ".market-grid"
            ]
        );

    if (!container) {
        return;
    }

    const cards = [];

    for (
        const market
        of CONFIG.markets
    ) {

        const data =
            DashboardState.markets[
                market.symbol
            ];

        if (!data) {

            cards.push(`
                <div class="market-card loading-card">

                    <div class="market-symbol">
                        ${escapeHTML(market.symbol)}
                    </div>

                    <div class="market-name">
                        ${escapeHTML(market.name)}
                    </div>

                    <div class="market-price">
                        --
                    </div>

                    <div class="market-change">
                        Waiting for data...
                    </div>

                </div>
            `);

            continue;
        }

        const positive =
            data.change >= 0;

        cards.push(`
            <div class="market-card">

                <div class="market-symbol">
                    ${escapeHTML(market.symbol)}
                </div>

                <div class="market-name">
                    ${escapeHTML(market.name)}
                </div>

                <div class="market-price">
                    ${formatPrice(
                        data.price,
                        market.symbol
                    )}
                </div>

                <div
                    class="market-change ${
                        positive
                            ? "positive"
                            : "negative"
                    }"
                >
                    ${
                        positive
                            ? "+"
                            : ""
                    }${data.change.toFixed(2)}%
                </div>

            </div>
        `);
    }

    container.innerHTML =
        cards.join("");

    const updated =
        $("marketLastUpdated");

    if (updated) {

        updated.textContent =
            `Last update: ${
                DashboardState.lastUpdated
                    ? DashboardState.lastUpdated
                        .toLocaleTimeString()
                    : "--"
            }`;
    }
}


/* ============================================================
   AI ENGINE STATUS
   ============================================================ */

function updateEngineStatus() {

    const element =
        $("engineStatus");

    if (!element) {
        return;
    }

    if (
        window.AIEngine &&
        typeof window.AIEngine.analyze ===
            "function"
    ) {

        const version =
            window.AIEngine.version ||
            window.AIEngine.VERSION ||
            "3.3.0-high-confluence";

        element.textContent =
            `AI Engine: ${version}`;

        element.classList.add(
            "online"
        );

    } else {

        element.textContent =
            "AI Engine: Not Loaded";

        element.classList.remove(
            "online"
        );
    }
}


/* ============================================================
   AI ANALYSIS
   ============================================================ */

function analyzeMarket(
    symbol,
    candles
) {

    if (
        !window.AIEngine ||
        typeof window.AIEngine.analyze !==
            "function"
    ) {

        return {
            status: "WAIT",
            grade: "WAIT",
            reason:
                "AI Engine unavailable."
        };
    }

    try {

        const result =
            window.AIEngine.analyze(
                symbol,
                candles
            );

        return result || {
            status: "WAIT",
            grade: "WAIT"
        };

    } catch (error) {

        log(
            `${symbol}: AI analysis failed - ${error.message}`,
            "error"
        );

        return {
            status: "WAIT",
            grade: "WAIT",
            reason:
                error.message
        };
    }
}


function runAIAnalysis() {

    log(
        "Starting AI market scan..."
    );

    const analyses = {};

    for (
        const symbol
        of CONFIG.analysisSymbols
    ) {

        const candles =
            DashboardState.candles[
                symbol
            ];

        if (
            !candles ||
            candles.length < 80
        ) {

            analyses[symbol] = {
                status: "WAIT",
                grade: "WAIT",
                reason:
                    "Insufficient candle data."
            };

            continue;
        }

        const analysis =
            analyzeMarket(
                symbol,
                candles
            );

        analyses[symbol] =
            analysis;

        log(
            `${symbol}: ${
                analysis.grade ||
                analysis.status ||
                "WAIT"
            }`
        );
    }

    DashboardState.analyses =
        analyses;

    renderAISetups();

    renderAIAnalysisCards();

    updateAPlusCount();

    return analyses;
}


/* ============================================================
   A+ SETUPS
   ============================================================ */

function getSetupFromAnalysis(
    analysis
) {

    if (!analysis) {
        return null;
    }

    return (
        analysis.setup ||
        analysis.signal ||
        null
    );
}


function isAPlusSetup(
    analysis
) {

    if (!analysis) {
        return false;
    }

    const setup =
        getSetupFromAnalysis(
            analysis
        );

    if (!setup) {
        return false;
    }

    const grade =
        String(
            setup.grade ??
            analysis.grade ??
            ""
        ).toUpperCase();

    const status =
        String(
            setup.status ??
            analysis.status ??
            ""
        ).toUpperCase();

    const score =
        safeNumber(
            setup.score ??
            analysis.score
        ) ?? 0;

    const confirmations =
        safeNumber(
            setup.confirmations ??
            setup.confirmationCount ??
            analysis.confirmations
        ) ?? 0;

    const rr =
        safeNumber(
            setup.rr ??
            setup.riskReward ??
            setup.riskRewardRatio
        ) ?? 0;

    return (
        (
            grade === "A+" ||
            status === "A+"
        ) &&
        score >= 82 &&
        confirmations >= 4 &&
        rr >= 1.25
    );
}


function renderAISetups() {

    const container =
        $("aiSetups");

    if (!container) {
        return;
    }

    const setups = [];

    for (
        const symbol
        of CONFIG.analysisSymbols
    ) {

        const analysis =
            DashboardState.analyses[
                symbol
            ];

        if (
            !isAPlusSetup(
                analysis
            )
        ) {
            continue;
        }

        const setup =
            getSetupFromAnalysis(
                analysis
            );

        if (!setup) {
            continue;
        }

        setups.push({
            symbol,
            setup
        });
    }

    if (!setups.length) {

        container.innerHTML = `
            <div class="empty-state">

                <strong>
                    WAIT
                </strong>

                <span>
                    No A+ setup detected.
                </span>

            </div>
        `;

        return;
    }

    container.innerHTML =
        setups
            .map(
                item =>
                    createSetupCard(
                        item.symbol,
                        item.setup
                    )
            )
            .join("");
}


function createSetupCard(
    symbol,
    setup
) {

    const direction =
        String(
            setup.direction ??
            setup.side ??
            setup.bias ??
            "WAIT"
        ).toUpperCase();

    const entry =
        setup.entry ??
        setup.entryPrice ??
        setup.entryZone ??
        "--";

    const stop =
        setup.stop ??
        setup.stopLoss ??
        "--";

    const tp1 =
        setup.tp1 ??
        setup.target1 ??
        "--";

    const tp2 =
        setup.tp2 ??
        setup.target2 ??
        "--";

    const score =
        setup.score ??
        "--";

    const rr =
        setup.rr ??
        setup.riskReward ??
        "--";

    const reasons =
        Array.isArray(
            setup.reasons
        )
            ? setup.reasons
            : [];

    return `
        <div class="setup-card">

            <div class="setup-header">

                <div>

                    <strong>
                        ${escapeHTML(symbol)}
                    </strong>

                    <span>
                        A+ SETUP
                    </span>

                </div>

                <div
                    class="setup-direction ${
                        direction === "LONG"
                            ? "positive"
                            : direction === "SHORT"
                                ? "negative"
                                : ""
                    }"
                >
                    ${escapeHTML(direction)}
                </div>

            </div>


            <div class="setup-metrics">

                <div>
                    <span>Entry</span>
                    <strong>
                        ${escapeHTML(entry)}
                    </strong>
                </div>

                <div>
                    <span>Stop</span>
                    <strong>
                        ${escapeHTML(stop)}
                    </strong>
                </div>

                <div>
                    <span>TP1</span>
                    <strong>
                        ${escapeHTML(tp1)}
                    </strong>
                </div>

                <div>
                    <span>TP2</span>
                    <strong>
                        ${escapeHTML(tp2)}
                    </strong>
                </div>

                <div>
                    <span>R:R</span>
                    <strong>
                        ${escapeHTML(rr)}
                    </strong>
                </div>

                <div>
                    <span>Score</span>
                    <strong>
                        ${escapeHTML(score)}
                    </strong>
                </div>

            </div>


            ${
                reasons.length
                    ? `
                        <div class="setup-reasons">

                            <strong>
                                Confluence
                            </strong>

                            <ul>
                                ${
                                    reasons
                                        .slice(0, 8)
                                        .map(
                                            reason =>
                                                `<li>${escapeHTML(reason)}</li>`
                                        )
                                        .join("")
                                }
                            </ul>

                        </div>
                    `
                    : ""
            }

        </div>
    `;
}


/* ============================================================
   A+ COUNT
   ============================================================ */

function updateAPlusCount() {

    const element =
        $("aPlusCount");

    if (!element) {
        return;
    }

    let count = 0;

    for (
        const symbol
        of CONFIG.analysisSymbols
    ) {

        if (
            isAPlusSetup(
                DashboardState.analyses[
                    symbol
                ]
            )
        ) {
            count++;
        }
    }

    element.textContent =
        `${count} A+`;
}


/* ============================================================
   AI ANALYSIS CARDS
   ============================================================ */

function renderAIAnalysisCards() {

    renderAnalysisCard(
        "XAUUSD",
        "analysisGold"
    );

    renderAnalysisCard(
        "USTEC",
        "analysisNasdaq"
    );

    renderAnalysisCard(
        "BTCUSD",
        "analysisBtc"
    );
}


function renderAnalysisCard(
    symbol,
    elementId
) {

    const element =
        $(elementId);

    if (!element) {
        return;
    }

    const analysis =
        DashboardState.analyses[
            symbol
        ];

    if (!analysis) {

        element.textContent =
            "Waiting for analysis...";

        return;
    }

    const setup =
        getSetupFromAnalysis(
            analysis
        );

    const grade =
        setup?.grade ??
        analysis.grade ??
        analysis.status ??
        "WAIT";

    const direction =
        setup?.direction ??
        setup?.side ??
        analysis.bias ??
        "WAIT";

    const score =
        setup?.score ??
        analysis.score ??
        "--";

    const regime =
        analysis.regime ??
        setup?.regime ??
        "--";

    const reason =
        setup?.reason ??
        analysis.reason ??
        analysis.message ??
        "No A+ setup currently confirmed.";

    element.innerHTML = `
        <div class="analysis-status">

            <strong>
                ${escapeHTML(grade)}
            </strong>

            <span>
                Bias:
                ${escapeHTML(direction)}
            </span>

        </div>

        <div class="analysis-details">

            <div>
                <span>Score</span>
                <strong>
                    ${escapeHTML(score)}
                </strong>
            </div>

            <div>
                <span>Regime</span>
                <strong>
                    ${escapeHTML(regime)}
                </strong>
            </div>

        </div>

        <p>
            ${escapeHTML(reason)}
        </p>
    `;
}


/* ============================================================
   SESSION CLOCKS
   ============================================================ */

function formatTimeZone(
    timeZone
) {

    try {

        return new Intl.DateTimeFormat(
            "en-GB",
            {
                timeZone,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false
            }
        ).format(
            new Date()
        );

    } catch (error) {

        return "--:--";
    }
}


function updateSessionClocks() {

    const zones = {
        kenyaTime:
            "Africa/Nairobi",

        utcTime:
            "UTC",

        sydneyTime:
            "Australia/Sydney",

        tokyoTime:
            "Asia/Tokyo",

        londonTime:
            "Europe/London",

        newYorkTime:
            "America/New_York"
    };

    for (
        const [
            elementId,
            timeZone
        ]
        of Object.entries(zones)
    ) {

        const element =
            $(elementId);

        if (!element) {
            continue;
        }

        element.textContent =
            formatTimeZone(
                timeZone
            );
    }
}


function startSessionClocks() {

    updateSessionClocks();

    if (
        DashboardState.clockTimer
    ) {

        clearInterval(
            DashboardState.clockTimer
        );
    }

    DashboardState.clockTimer =
        setInterval(
            updateSessionClocks,
            1000
        );
}


/* ============================================================
   DRIVER HELPERS
   ============================================================ */

function calculateDriverChange(
    current,
    previous
) {

    const c =
        safeNumber(current);

    const p =
        safeNumber(previous);

    if (
        c === null ||
        p === null ||
        p === 0
    ) {
        return null;
    }

    return (
        (c - p) /
        p
    ) * 100;
}


function setText(
    id,
    value
) {

    const element =
        $(id);

    if (element) {
        element.textContent =
            value ?? "--";
    }
}


/* ============================================================
   LIVE DRIVER CARDS
   ============================================================ */

function renderBasicDrivers() {

    const dxy =
        DashboardState.markets.DXY;

    const oil =
        DashboardState.markets.USOIL;

    const nasdaq =
        DashboardState.markets.USTEC;

    const btc =
        DashboardState.markets.BTCUSD;


    if (dxy) {

        setText(
            "driverDxyCurrent",
            formatPrice(
                dxy.price,
                "DXY"
            )
        );

        setText(
            "driverDxyPrevious",
            formatPrice(
                dxy.previousClose,
                "DXY"
            )
        );

        setText(
            "driverDxyChange",
            formatPercent(
                dxy.change
            )
        );

        setText(
            "driverDxyImpact",
            dxy.change > 0
                ? "Potential Gold headwind"
                : "Potential Gold support"
        );

        setText(
            "driverDxyInterpretation",
            dxy.change > 0
                ? "Dollar strengthening."
                : "Dollar weakening."
        );
    }


    if (oil) {

        setText(
            "driverOilCurrent",
            formatPrice(
                oil.price,
                "USOIL"
            )
        );

        setText(
            "driverOilPrevious",
            formatPrice(
                oil.previousClose,
                "USOIL"
            )
        );

        setText(
            "driverOilChange",
            formatPercent(
                oil.change
            )
        );

        setText(
            "driverOilImpact",
            oil.change > 0
                ? "Inflation pressure"
                : "Inflation pressure easing"
        );

        setText(
            "driverOilInterpretation",
            oil.change > 0
                ? "Oil is rising."
                : "Oil is falling."
        );
    }


    if (nasdaq) {

        setText(
            "driverNasdaqCurrent",
            formatPrice(
                nasdaq.price,
                "USTEC"
            )
        );

        setText(
            "driverNasdaqPrevious",
            formatPrice(
                nasdaq.previousClose,
                "USTEC"
            )
        );

        setText(
            "driverNasdaqChange",
            formatPercent(
                nasdaq.change
            )
        );

        setText(
            "driverNasdaqImpact",
            nasdaq.change > 0
                ? "Risk-on"
                : "Risk-off"
        );

        setText(
            "driverNasdaqInterpretation",
            nasdaq.change > 0
                ? "Nasdaq is gaining."
                : "Nasdaq is declining."
        );
    }


    if (btc) {

        setText(
            "driverBtcCurrent",
            formatPrice(
                btc.price,
                "BTCUSD"
            )
        );

        setText(
            "driverBtcPrevious",
            formatPrice(
                btc.previousClose,
                "BTCUSD"
            )
        );

        setText(
            "driverBtcChange",
            formatPercent(
                btc.change
            )
        );

        setText(
            "driverBtcImpact",
            btc.change > 0
                ? "Risk appetite support"
                : "Risk appetite pressure"
        );

        setText(
            "driverBtcInterpretation",
            btc.change > 0
                ? "Bitcoin is gaining."
                : "Bitcoin is declining."
        );
    }
}


/* ============================================================
   MARKET SESSION STATE
   ============================================================ */

function getSessionState() {

    const hour =
        Number(
            new Intl.DateTimeFormat(
                "en-GB",
                {
                    timeZone:
                        "Africa/Nairobi",
                    hour:
                        "2-digit",
                    hour12:
                        false
                }
            ).format(
                new Date()
            )
        );

    if (
        hour >= 8 &&
        hour < 17
    ) {
        return "London";
    }

    if (
        hour >= 15 &&
        hour < 23
    ) {
        return "New York";
    }

    if (
        hour >= 1 &&
        hour < 10
    ) {
        return "Asia";
    }

    return "Transition";
}


/* ============================================================
   MARKET DRIVER INTERPRETATION
   ============================================================ */

function renderDriverInterpretation() {

    const session =
        getSessionState();

    log(
        `Current primary session: ${session}`
    );

    renderBasicDrivers();
}


/* ============================================================
   DAILY EVENT PLACEHOLDER
   ============================================================ */

function renderDailyEvents() {

    const body =
        $("dailyEventsBody");

    if (!body) {
        return;
    }

    body.innerHTML = `
        <tr>
            <td colspan="7">
                Macro event feed not connected.
                Use the dashboard as the market-structure
                layer while macro events are supplied.
            </td>
        </tr>
    `;
}


/* ============================================================
   WEEKLY DRIVER PLACEHOLDER
   ============================================================ */

function renderWeeklyDrivers() {

    const body =
        $("weeklyDriversBody");

    if (!body) {
        return;
    }

    const rows = [
        [
            "Fed expectations",
            "--",
            "--",
            "Monitor",
            "Rates-sensitive",
            "Check CME rate probabilities."
        ],
        [
            "US Dollar",
            "--",
            DashboardState.markets.DXY
                ? formatPrice(
                    DashboardState.markets.DXY.price,
                    "DXY"
                )
                : "--",
            DashboardState.markets.DXY
                ? (
                    DashboardState.markets.DXY.change >= 0
                        ? "Higher"
                        : "Lower"
                )
                : "--",
            "Gold / risk sentiment",
            "Monitor DXY direction and structure."
        ],
        [
            "Treasury Yields",
            "--",
            "--",
            "Monitor",
            "Gold / Nasdaq",
            "Watch US 10Y yield and real-rate expectations."
        ],
        [
            "Global Liquidity",
            "--",
            "--",
            "Monitor",
            "Risk assets",
            "Use higher-timeframe liquidity conditions."
        ]
    ];

    body.innerHTML =
        rows
            .map(
                row => `
                    <tr>
                        ${row
                            .map(
                                cell =>
                                    `<td>${escapeHTML(cell)}</td>`
                            )
                            .join("")
                        }
                    </tr>
                `
            )
            .join("");
}


/* ============================================================
   REFRESH DASHBOARD
   ============================================================ */

async function refreshDashboard() {

    if (
        DashboardState.running
    ) {
        return;
    }

    DashboardState.running =
        true;

    try {

        await loadLiveMarkets();

        renderDriverInterpretation();

        renderDailyEvents();

        renderWeeklyDrivers();

        runAIAnalysis();

        log(
            "Dashboard scan complete."
        );

    } catch (error) {

        log(
            `Dashboard refresh failed: ${error.message}`,
            "error"
        );

    } finally {

        DashboardState.running =
            false;
    }
}


/* ============================================================
   AUTO REFRESH
   ============================================================ */

function startAutoRefresh() {

    if (
        DashboardState.refreshTimer
    ) {

        clearInterval(
            DashboardState.refreshTimer
        );
    }

    DashboardState.refreshTimer =
        setInterval(
            () => {
                refreshDashboard();
            },
            CONFIG.refreshMs
        );
}


/* ============================================================
   CLEAR LOG BUTTON
   ============================================================ */

function bindControls() {

    const clearButton =
        $("clearLog");

    if (clearButton) {

        clearButton.addEventListener(
            "click",
            clearLog
        );
    }
}


/* ============================================================
   INITIALIZATION
   ============================================================ */

async function startDashboard() {

    log(
        "Starting Market Drivers AI Dashboard..."
    );

    updateEngineStatus();

    bindControls();

    startSessionClocks();

    renderDailyEvents();

    renderWeeklyDrivers();

    await refreshDashboard();

    startAutoRefresh();

    log(
        "Dashboard ready."
    );
}


/* ============================================================
   GLOBAL EXPORTS
   ============================================================ */

window.DashboardState =
    DashboardState;

window.loadLiveMarkets =
    loadLiveMarkets;

window.runAIAnalysis =
    runAIAnalysis;

window.refreshDashboard =
    refreshDashboard;

window.startDashboard =
    startDashboard;


/* ============================================================
   START
   ============================================================ */

if (
    document.readyState ===
    "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        startDashboard,
        {
            once: true
        }
    );

} else {

    startDashboard();
}