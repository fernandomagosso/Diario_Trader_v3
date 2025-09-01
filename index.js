/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI } from "@google/genai";
import { marked } from "marked";
import { Chart, registerables } from "chart.js";
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';

// --- TYPES AND INTERFACES (JSDoc) ---
/**
 * @typedef {object} Trade
 * @property {number} id
 * @property {string} asset
 * @property {number} tradeNumber
 * @property {'Compra' | 'Venda'} side
 * @property {string} date - Stored as YYYY-MM-DD
 * @property {number} lots
 * @property {number} entryPrice
 * @property {number} exitPrice
 * @property {number} points
 * @property {number} result
 * @property {string} [notes]
 * @property {string} region
 * @property {string} structure
 * @property {string} trigger
 */

/**
 * @typedef {object} RegOptions
 * @property {string[]} regions
 * @property {string[]} structures
 * @property {string[]} triggers
 */

/**
 * @typedef {object} Filters
 * @property {string} asset
 * @property {'Todos' | 'Compra' | 'Venda'} side
 * @property {string} date
 * @property {'Todos' | 'Gain' | 'Loss'} result
 */

/**
 * @typedef {object} GoogleAuthState
 * @property {boolean} isSignedIn
 * @property {string} user
 */


// --- UTILITIES ---
/**
 * Creates a debounced function that delays invoking `func` until after `waitFor`
 * milliseconds have elapsed since the last time the debounced function was invoked.
 * @template {(...args: any[]) => any} F
 * @param {F} func The function to debounce.
 * @param {number} waitFor The number of milliseconds to delay.
 * @returns {(...args: Parameters<F>) => void} A new debounced function.
 */
const debounce = (func, waitFor) => {
    let timeout = null;
    return (...args) => {
        if (timeout !== null) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => func(...args), waitFor);
    };
};

/**
 * Parses a string number from various locales into a float.
 * @param {string | null} value The string to parse.
 * @returns {number}
 */
const parseLocaleNumber = (value) => {
    if (typeof value !== 'string' || !value) {
        return NaN;
    }
    const sanitized = value.trim();
    const hasComma = sanitized.includes(',');
    const hasDot = sanitized.includes('.');

    // If both are present, we need to decide which is the decimal separator.
    if (hasComma && hasDot) {
        // If comma is last, assume pt-BR format (e.g., '1.234,56')
        if (sanitized.lastIndexOf(',') > sanitized.lastIndexOf('.')) {
            return parseFloat(sanitized.replace(/\./g, '').replace(',', '.'));
        }
        // If dot is last, assume en-US format (e.g., '1,234.56')
        else {
            return parseFloat(sanitized.replace(/,/g, ''));
        }
    }

    // If only comma is present, it must be the decimal separator
    if (hasComma) {
        return parseFloat(sanitized.replace(',', '.'));
    }

    // If only dot is present, or none, parseFloat can handle it directly.
    return parseFloat(sanitized);
};


// --- INITIALIZATION & CONFIG ---
Chart.register(...registerables);
/** @type {GoogleGenAI | null} */
let ai = null;
/** @type {Error | null} */
let aiInitializationError = null;
const appRoot = document.getElementById('app-root');

/** @type {Trade[]} */
let trades = [];
/** @type {Trade | null} */
let editingTrade = null;
/** @type {number | null} */
let deletingTradeId = null;
/** @type {Filters} */
let filters = { asset: '', side: 'Todos', date: '', result: 'Todos' };
/** @type {RegOptions} */
let regOptions = {
    regions: ['Região Barata', 'Região Cara', 'Consolidação'],
    structures: ['A-B-C de Alta', 'A-B-C de Baixa'],
    triggers: ['Cadeado de Alta', 'Cadeado de Baixa', '2-2-1', 'Pivot Disfarçado']
};
/** @type {Object.<string, Chart>} */
let charts = {};
const debouncedRender = debounce(render, 300);

// Google Sheets Config
const GOOGLE_CLIENT_ID = '312225788265-5akif4pd2ebspjuui79m6qe1807an145.apps.googleusercontent.com';
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/spreadsheets';
let isGapiReady = false;
let isGisReady = false;
/** @type {GoogleAuthState} */
let googleAuthState = { isSignedIn: false, user: '' };
const spreadsheetId = '1E8Is9CKoipS2sdw0o-WLtYecMXoRlZRIrM2aLI4VhAk';
let tokenClient;
let isAuthorizingInteractively = false;


// --- STATE MANAGEMENT & PERSISTENCE ---
const saveState = () => {
    localStorage.setItem('trades', JSON.stringify(trades));
    localStorage.setItem('regOptions', JSON.stringify(regOptions));
};

const loadState = () => {
    const savedTrades = localStorage.getItem('trades');
    const savedRegOptions = localStorage.getItem('regOptions');
    if (savedTrades) trades = JSON.parse(savedTrades);
    if (savedRegOptions) regOptions = JSON.parse(savedRegOptions);
};

// --- GOOGLE SHEETS INTEGRATION ---
const gapiLoaded = () => {
    gapi.load('client', initializeGapiClient);
};

const gisLoaded = () => {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: GOOGLE_SCOPES,
        callback: (tokenResponse) => {
            const wasInteractive = isAuthorizingInteractively;
            isAuthorizingInteractively = false; // Reset flag on any callback
            if (tokenResponse && tokenResponse.access_token) {
                gapi.client.setToken(tokenResponse);
                googleAuthState.isSignedIn = true;
                googleAuthState.user = 'Conectado';
                render();
            }
            else {
                console.error('Authentication failed: No access token in response.', tokenResponse);
                if (wasInteractive) {
                    googleAuthState.isSignedIn = false;
                    googleAuthState.user = 'Falha';
                    render();
                    alert('Falha na autenticação: Resposta inválida do Google.');
                }
            }
        },
        error_callback: (error) => {
            const wasInteractive = isAuthorizingInteractively;
            isAuthorizingInteractively = false; // Reset flag for next attempt
            // Handle only interactive errors with user-facing messages
            if (wasInteractive) {
                googleAuthState.isSignedIn = false;
                // Check for specific OAuth configuration errors first.
                const errorString = JSON.stringify(error);
                if (errorString.includes('invalid_client') || errorString.includes('unauthorized_client')) {
                    console.error('Fatal Google Auth Configuration Error:', error);
                    googleAuthState.user = 'Erro de Configuração';
                    render();
                    alert(`Erro Crítico na Configuração da Integração: Cliente inválido. Verifique se o Client ID está correto e autorizado no Google Cloud Console.`);
                    return; // Stop further processing.
                }
                // Handle other known interactive errors.
                if (error.type === 'popup_failed_to_open') {
                    console.error('Authentication error: The browser blocked the popup.', error);
                    googleAuthState.user = 'Pop-up Bloqueado';
                    render();
                    alert("A janela de login do Google foi bloqueada pelo seu navegador. Por favor, procure por um ícone de pop-up bloqueado na barra de endereço e permita pop-ups para este site.");
                }
                else if (error.type === 'popup_closed') {
                    // This is a user action, not a critical error.
                    console.log('Authentication flow was cancelled by the user.');
                    googleAuthState.user = 'Autorização Cancelada';
                    render();
                }
                else {
                    // Catch-all for other unexpected errors.
                    console.error('Authentication error: An unexpected error occurred.', error);
                    googleAuthState.user = 'Erro de Autenticação';
                    render();
                    alert(`Ocorreu um erro inesperado durante a autenticação: ${error.message || 'Verifique o console.'}`);
                }
            }
            else {
                // Silent auth failed, this is normal for new users, no need to do anything.
                console.log("Silent auth failed, which is expected for users needing to grant consent.", error);
            }
        }
    });
    isGisReady = true;
    render();
};

const initializeGapiClient = async () => {
    await gapi.client.init({
        discoveryDocs: ['https://sheets.googleapis.com/$discovery/rest?version=v4'],
    });
    isGapiReady = true;
    render();
};

const handleAuthClick = () => {
    isAuthorizingInteractively = true;
    // An empty prompt is usually best. 'consent' forces re-approval every time.
    tokenClient.requestAccessToken({ prompt: '' });
};

const handleSignoutClick = () => {
    const token = gapi.client.getToken();
    if (token !== null) {
        google.accounts.oauth2.revoke(token.access_token, () => {
            gapi.client.setToken('');
            googleAuthState.isSignedIn = false;
            googleAuthState.user = '';
            render();
        });
    }
};

const syncToSheet = async (options = {}) => {
    if (!spreadsheetId) {
        if (!options.silent) alert('ID da Planilha não configurado.');
        return;
    }

    const syncButton = document.getElementById('sync-sheets');
    if (syncButton) {
        syncButton.textContent = 'Sincronizando...';
        syncButton.setAttribute('disabled', 'true');
    }

    const sheetName = 'Trades';
    const headerRow = [
        'ID', 'Ativo', '# Operação', 'Lado', 'Data', 'Lotes', 'Preço Entrada',
        'Preço Saída', 'Pontos', 'Resultado R$', 'Região', 'Estrutura', 'Gatilho', 'Notas'
    ];
    const tradeToRow = (t) => [
        t.id, t.asset, t.tradeNumber, t.side, t.date, t.lots, t.entryPrice,
        t.exitPrice, t.points, t.result, t.region, t.structure, t.trigger, t.notes || ''
    ];

    try {
        // Step 1: Ensure the sheet exists, create if not.
        try {
            const spreadsheet = await gapi.client.sheets.spreadsheets.get({
                spreadsheetId: spreadsheetId,
            });
            const sheetExists = spreadsheet.result.sheets.some((s) => s.properties.title === sheetName);
            if (!sheetExists) {
                await gapi.client.sheets.spreadsheets.batchUpdate({
                    spreadsheetId: spreadsheetId,
                    resource: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
                });
            }
        }
        catch (err) {
            if (err.result?.error?.code === 404) {
                throw new Error('Planilha não encontrada. Verifique o ID da planilha.');
            }
            throw err;
        }

        // Step 2: Get current data from the sheet to map existing trades.
        const getResponse = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: sheetName,
        });

        const sheetValues = getResponse.result.values || [];
        const sheetHeader = sheetValues[0] || [];
        const headerIsMissingOrInvalid = headerRow.some((h, i) => h !== sheetHeader[i]);
        
        const sheetTradesMap = new Map(); // Map<id_string, row_index_1_based>
        if (!headerIsMissingOrInvalid) {
            sheetValues.slice(1).forEach((row, index) => {
                const id = row[0];
                if (id) {
                    // index is 0-based for the sliced array (data rows).
                    // Sheet row index is index + 2.
                    sheetTradesMap.set(String(id), index + 2);
                }
            });
        }

        // Step 3: Categorize local trades into updates (exist in sheet) and appends (new)
        const dataForBatchUpdate = [];
        const valuesToAppend = [];

        for (const trade of trades) {
            const rowIndex = sheetTradesMap.get(String(trade.id));
            if (rowIndex) { // Trade exists -> UPDATE
                dataForBatchUpdate.push({
                    range: `${sheetName}!A${rowIndex}`,
                    values: [tradeToRow(trade)],
                });
            } else { // Trade is new -> APPEND
                valuesToAppend.push(tradeToRow(trade));
            }
        }

        // Step 4: Execute sheet modifications
        
        // Ensure header is present and correct before proceeding
        if (headerIsMissingOrInvalid) {
            await gapi.client.sheets.spreadsheets.values.update({
                spreadsheetId: spreadsheetId,
                range: `${sheetName}!A1`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [headerRow] },
            });
        }
        
        // Perform batch update for existing trades
        if (dataForBatchUpdate.length > 0) {
            await gapi.client.sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: spreadsheetId,
                resource: {
                    valueInputOption: 'USER_ENTERED',
                    data: dataForBatchUpdate,
                },
            });
        }

        // Append all new trades in a single call
        if (valuesToAppend.length > 0) {
            await gapi.client.sheets.spreadsheets.values.append({
                spreadsheetId: spreadsheetId,
                range: sheetName, // Appending to the table will find the first empty row
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                resource: { values: valuesToAppend },
            });
        }
        
        if (!options.silent) {
            const updatedCount = dataForBatchUpdate.length;
            const appendedCount = valuesToAppend.length;
            alert(`Sincronização concluída!\n- ${updatedCount} operação(ões) atualizada(s).\n- ${appendedCount} nova(s) operação(ões) adicionada(s).`);
        }

    }
    catch (err) {
        console.error('Erro na sincronização:', err);
        let errorMessage = 'Falha ao sincronizar com a planilha.';
        if (err.result?.error?.message) {
            errorMessage += `\nDetalhes: ${err.result.error.message}`;
        }
        else if (err.message) {
            errorMessage += `\nDetalhes: ${err.message}`;
        } else {
            errorMessage += '\nVerifique a conexão e as permissões da planilha.';
        }
        
        const alertPrefix = options.silent 
            ? 'Erro na sincronização automática em segundo plano.' 
            : 'Ocorreu um erro ao sincronizar.';
            
        alert(`${alertPrefix}\n\n${errorMessage}`);
    }
    finally {
        if (syncButton) {
            syncButton.textContent = 'Sincronizar';
            if (googleAuthState.isSignedIn) {
                syncButton.removeAttribute('disabled');
            }
        }
    }
};

// --- CORE LOGIC ---
/**
 * @param {{ region: string; structure: string; trigger: string; }} tradeData
 */
const updateRegOptionsIfNeeded = (tradeData) => {
    let optionsChanged = false;
    const newRegion = tradeData.region.trim();
    const newStructure = tradeData.structure.trim();
    const newTrigger = tradeData.trigger.trim();

    if (newRegion && !regOptions.regions.includes(newRegion)) {
        regOptions.regions.push(newRegion);
        optionsChanged = true;
    }
    if (newStructure && !regOptions.structures.includes(newStructure)) {
        regOptions.structures.push(newStructure);
        optionsChanged = true;
    }
    if (newTrigger && !regOptions.triggers.includes(newTrigger)) {
        regOptions.triggers.push(newTrigger);
        optionsChanged = true;
    }
    return optionsChanged;
};

const handleApiKeySubmit = async (event) => {
    event.preventDefault();
    const form = event.target;
    const apiKeyInput = form.elements.namedItem('api-key-input');
    const apiKey = apiKeyInput.value.trim();
    const statusEl = document.getElementById('api-key-status');

    if (!apiKey) {
        if (statusEl) {
            statusEl.textContent = 'Por favor, insira uma chave de API.';
            statusEl.className = 'api-key-status error';
        }
        return;
    }

    if (statusEl) {
        statusEl.textContent = 'Validando chave...';
        statusEl.className = 'api-key-status loading';
    }
    
    try {
        const tempAi = new GoogleGenAI({ apiKey });
        await tempAi.models.generateContent({ model: 'gemini-2.5-flash', contents: 'test' });

        sessionStorage.setItem('userApiKey', apiKey);
        await attemptAiInitialization();
        render();

    } catch (error) {
        console.error("API Key validation failed:", error);
        if (statusEl) {
            statusEl.textContent = 'Chave de API inválida ou erro de rede. Tente novamente.';
            statusEl.className = 'api-key-status error';
        }
        sessionStorage.removeItem('userApiKey');
        ai = null;
    }
};

const attemptAiInitialization = async () => {
    ai = null;
    aiInitializationError = null;
    
    const userApiKey = sessionStorage.getItem('userApiKey');
    const envApiKey = (typeof process !== 'undefined' && process.env?.API_KEY) ? process.env.API_KEY : null;
    const apiKey = userApiKey || envApiKey;

    if (!apiKey) {
        aiInitializationError = new Error("A chave da API não está configurada no ambiente.");
        console.warn("AI Initialization Failed: API_KEY is not configured.");
        return;
    }

    try {
        const genAI = new GoogleGenAI({ apiKey });
        await genAI.models.generateContent({ model: 'gemini-2.5-flash', contents: 'ping' });
        ai = genAI;
    } catch (error) {
        aiInitializationError = new Error("A chave de API fornecida é inválida ou a conexão falhou.");
        console.error("AI Initialization Failed:", error.message);
        if (userApiKey) {
            sessionStorage.removeItem('userApiKey');
        }
    }
};


/**
 * @param {Trade} trade
 */
const getAIInsight = async (trade) => {
    if (!ai) {
        alert("Cliente de IA não inicializado.");
        return;
    }
    const insightContainer = document.getElementById('ai-insight-content');
    if (!insightContainer) return;
    insightContainer.parentElement.classList.add('loading');
    insightContainer.innerHTML = 'Analisando sua operação...';

    const prompt = `
        Análise de Trade Rápida:
        - Ativo: ${trade.asset}
        - Lado: ${trade.side}
        - Resultado: ${trade.result > 0 ? 'Gain' : 'Loss'} de R$ ${Math.abs(trade.result).toFixed(2)} (${trade.points} pontos)
        - Estratégia REG: Região (${trade.region}), Estrutura (${trade.structure}), Gatilho (${trade.trigger})

        Com base nesses dados, gere dois outputs separados por '---RESUMO---':
        1.  **Insight Amigável:** Um insight para o trader. Seja amigável, direto e ajude-o a refletir. Foque em um ponto positivo se foi gain, ou um ponto de atenção se foi loss. Use markdown para formatação.
        2.  **Resumo em Tópicos:** Um resumo conciso da análise em 2 ou 3 tópicos curtos (bullet points), ideal para anotações.
    `;
    
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });
        
        const responseText = response.text;
        const parts = responseText.split('---RESUMO---');
        const friendlyInsight = parts[0] || 'Não foi possível gerar o insight detalhado.';
        const summaryNotes = parts[1] || '';

        insightContainer.innerHTML = await marked.parse(friendlyInsight.trim());

        if (summaryNotes) {
            const tradeIndex = trades.findIndex(t => t.id === trade.id);
            if (tradeIndex !== -1) {
                trades[tradeIndex].notes = summaryNotes.trim();
                saveState();
            }
        }
    } catch (error) {
        console.error("Error fetching AI insight:", error);
        insightContainer.innerHTML = 'Não foi possível obter o insight. Verifique o console para mais detalhes.';
    } finally {
        insightContainer.parentElement.classList.remove('loading');
    }
};

/**
 * @param {'Compra' | 'Venda'} side
 * @param {number} lots
 * @param {number} entryPrice
 * @param {number} exitPrice
 */
const calculateTradeMetrics = (side, lots, entryPrice, exitPrice) => {
    const points = side === 'Compra' ? exitPrice - entryPrice : entryPrice - exitPrice;
    const result = points * 10 * lots; // Assuming WDOFUT logic for simplicity
    return { points: parseFloat(points.toFixed(2)), result: parseFloat(result.toFixed(2)) };
}

/**
 * @param {HTMLFormElement} form
 * @returns {boolean}
 */
const validateTradeForm = (form) => {
    let isFormValid = true;
    
    const fields = [
        { id: 'asset', required: true },
        { id: 'date', required: true },
        { id: 'lots', required: true, isNumeric: true },
        { id: 'entry-price', required: true, isNumeric: true },
        { id: 'exit-price', required: true, isNumeric: true },
        { id: 'regions', required: true },
        { id: 'structures', required: true },
        { id: 'triggers', required: true }
    ];

    fields.forEach(field => {
        const input = document.getElementById(field.id);
        const errorEl = document.getElementById(`${field.id}-error`);
        if (!input) return;

        input.classList.remove('is-invalid');
        if (errorEl) errorEl.textContent = '';

        const value = input.value.trim();
        let errorMessage = '';

        if (field.required && !value) {
            errorMessage = 'Este campo é obrigatório.';
        } else if (value && field.isNumeric && isNaN(parseLocaleNumber(value))) {
            errorMessage = 'Por favor, insira um número válido.';
        }

        if (errorMessage) {
            isFormValid = false;
            input.classList.add('is-invalid');
            if (errorEl) errorEl.textContent = errorMessage;
        }
    });

    return isFormValid;
};


/**
 * @param {SubmitEvent} event
 */
const addTrade = (event) => {
    event.preventDefault();
    const form = event.target;
    
    if (!validateTradeForm(form)) {
        return;
    }

    const formData = new FormData(form);
    
    const side = formData.get('side');
    const lots = parseLocaleNumber(formData.get('lots'));
    const entryPrice = parseLocaleNumber(formData.get('entry-price'));
    const exitPrice = parseLocaleNumber(formData.get('exit-price'));
    const { points, result } = calculateTradeMetrics(side, lots, entryPrice, exitPrice);

    const nextTradeNumber = trades.length > 0 ? Math.max(...trades.map(t => t.tradeNumber)) + 1 : 1;

    /** @type {Trade} */
    const newTrade = {
        id: Date.now(),
        asset: formData.get('asset'),
        tradeNumber: nextTradeNumber,
        side,
        date: formData.get('date'),
        lots,
        entryPrice,
        exitPrice,
        points,
        result,
        notes: formData.get('notes'),
        region: formData.get('regions'),
        structure: formData.get('structures'),
        trigger: formData.get('triggers'),
    };
    
    trades.push(newTrade);
    updateRegOptionsIfNeeded(newTrade);
    saveState();

    if (googleAuthState.isSignedIn) {
        syncToSheet({ silent: true });
    }
    
    const assetToKeep = form.elements.namedItem('asset').value;
    const dateToKeep = form.elements.namedItem('date').value;
    render();
    const newForm = document.getElementById('trade-form');
    if (newForm) {
        newForm.elements.namedItem('asset').value = assetToKeep;
        newForm.elements.namedItem('date').value = dateToKeep;
        newForm.elements.namedItem('entry-price').focus();
    }

    getAIInsight(newTrade);
};

/**
 * @param {SubmitEvent} event
 */
const updateTrade = (event) => {
    event.preventDefault();
    if (!editingTrade) return;

    const form = event.target;
    if (!validateTradeForm(form)) {
        return;
    }

    const formData = new FormData(form);

    const side = formData.get('side');
    const lots = parseLocaleNumber(formData.get('lots'));
    const entryPrice = parseLocaleNumber(formData.get('entry-price'));
    const exitPrice = parseLocaleNumber(formData.get('exit-price'));
    const { points, result } = calculateTradeMetrics(side, lots, entryPrice, exitPrice);

    const updatedTrade = {
        ...editingTrade,
        asset: formData.get('asset'),
        side,
        date: formData.get('date'),
        lots,
        entryPrice,
        exitPrice,
        points,
        result,
        notes: formData.get('notes'),
        region: formData.get('regions'),
        structure: formData.get('structures'),
        trigger: formData.get('triggers'),
    };
    
    const tradeIndex = trades.findIndex(t => t.id === editingTrade.id);
    if (tradeIndex !== -1) {
        trades[tradeIndex] = updatedTrade;
    }

    updateRegOptionsIfNeeded(updatedTrade);
    saveState();

    if (googleAuthState.isSignedIn) {
        syncToSheet({ silent: true });
    }

    closeEditModal();
};

/**
 * @param {number} id
 */
const openDeleteModal = (id) => {
    deletingTradeId = id;
    render();
};

const closeDeleteModal = () => {
    deletingTradeId = null;
    render();
};

const confirmDelete = () => {
    if (deletingTradeId === null) return;
    trades = trades.filter(t => t.id !== deletingTradeId);
    saveState();
    // A sincronização não é chamada aqui para garantir que nenhuma
    // operação seja removida da planilha. A planilha funciona como um log
    // permanente e um backup de todas as operações inseridas.
    closeDeleteModal();
};

/**
 * @param {number} id
 */
const openEditModal = (id) => {
    editingTrade = trades.find(t => t.id === id) || null;
    render();
};

const closeEditModal = () => {
    editingTrade = null;
    render();
};


const exportToCSV = () => {
    if (trades.length === 0) return;

    const headerConfig = [
        { key: 'id', label: 'id' },
        { key: 'asset', label: 'asset' },
        { key: 'tradeNumber', label: 'tradeNumber' },
        { key: 'side', label: 'side' },
        { key: 'date', label: 'date' },
        { key: 'lots', label: 'Contratos/Quantidade' },
        { key: 'entryPrice', label: 'entryPrice' },
        { key: 'exitPrice', label: 'exitPrice' },
        { key: 'points', label: 'Resultado Pontos' },
        { key: 'result', label: 'Resultado Monetário/R$' },
        { key: 'region', label: 'region' },
        { key: 'structure', label: 'structure' },
        { key: 'trigger', label: 'trigger' },
    ];
    
    const headerRow = headerConfig.map(h => h.label).join(',');

    const rows = trades.map(trade => {
        return headerConfig.map(h => trade[h.key]).join(',');
    }).join('\n');
    
    const csvContent = `data:text/csv;charset=utf-8,${headerRow}\n${rows}`;
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `trades_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

/**
 * Renders text with support for **bold** markdown, handling word wrapping.
 * @param {jsPDF} pdf
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {number} maxWidth
 * @param {number} lineHeight
 * @returns {number} The new Y coordinate after rendering the text.
 */
const addWrappedTextWithBold = (pdf, text, x, y, maxWidth, lineHeight) => {
    const parts = text.split(/(\*\*.*?\*\*)/g).filter(p => p.length > 0);
    
    let currentX = x;
    const spaceWidth = pdf.getStringUnitWidth(' ') * pdf.getFontSize() / pdf.internal.scaleFactor;

    for (const part of parts) {
        const isBold = part.startsWith('**') && part.endsWith('**');
        const content = isBold ? part.slice(2, -2) : part;
        pdf.setFont('helvetica', isBold ? 'bold' : 'normal');

        const words = content.split(/\s+/).filter(w => w.length > 0);

        for (const word of words) {
            const wordWidth = pdf.getStringUnitWidth(word) * pdf.getFontSize() / pdf.internal.scaleFactor;
            
            if (currentX + wordWidth > x + maxWidth) {
                y += lineHeight;
                currentX = x;
            }

            pdf.text(word, currentX, y);
            currentX += wordWidth + spaceWidth;
        }
    }
    return y;
};


const exportToPDF = async () => {
    if (!ai) {
        alert("Cliente de IA não inicializado. Forneça uma chave de API válida.");
        return;
    }
    if (trades.length === 0) {
        alert("Não há operações para gerar um relatório.");
        return;
    }

    const exportButton = document.getElementById('export-pdf');
    if (!exportButton) {
        console.error('Export button not found');
        return;
    }

    exportButton.textContent = 'Gerando Relatório IA...';
    exportButton.setAttribute('disabled', 'true');

    try {
        // --- 1. Capture Dashboard Image ---
        const dashboardElement = document.getElementById('performance-dashboard-card');
        if (!dashboardElement) {
            throw new Error("Dashboard element not found for PDF export.");
        }
        const canvas = await html2canvas(dashboardElement, {
            scale: 2, // Higher resolution for better PDF quality
            backgroundColor: '#1e1e1e', // Match the card background color
            useCORS: true,
        });
        const imgData = canvas.toDataURL('image/png');

        // --- 2. Get AI Analysis ---
        const tradesSummary = trades.map(t =>
            `- Op #${t.tradeNumber}: ${t.asset}, ${t.side}, Resultado: R$ ${t.result.toFixed(2)}, Gatilho: ${t.trigger}`
        ).join('\n');

        const prompt = `
            Você é um coach de traders profissional e amigável. Analise o seguinte histórico de operações de um trader e gere um relatório de performance detalhado.

            Histórico de Operações:
            ${tradesSummary}

            Instruções para o relatório:
            1. **Linguagem:** Use uma linguagem amigável, encorajadora e fácil de entender, como se estivesse conversando com o trader.
            2. **Estrutura:** Organize o conteúdo em seções claras com títulos (usando markdown). Sugestões de seções:
                - **Análise da Performance:** Um resumo dos resultados gerais (lucro/prejuízo, taxa de acerto), explicando o que os números significam.
                - **Seus Pontos Fortes:** Identifique padrões positivos, como os gatilhos mais lucrativos ou ativos com maior sucesso. Elogie o que está funcionando.
                - **Pontos de Melhoria:** Identifique com cuidado os padrões que estão causando perdas. Seja construtivo.
                - **Análise por Gatilho:** Faça uma análise breve sobre a performance dos gatilhos utilizados.
            3. **Resumo e Próximos Passos:** Termine com um resumo conciso e forneça 2 ou 3 pontos de ação claros e práticos para o trader focar.

            O relatório deve ser completo, mas direto ao ponto. Use markdown para formatação (títulos com '##', listas com '-', negrito com '**').
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });
        const reportText = response.text;

        // --- 3. Assemble the PDF ---
        const pdf = new jsPDF('p', 'mm', 'a4');
        const pageHeight = pdf.internal.pageSize.getHeight();
        const pageWidth = pdf.internal.pageSize.getWidth();
        const margin = 15;
        let y = margin;

        // Add the dashboard image first
        const imgProps = pdf.getImageProperties(imgData);
        const pdfWidth = pageWidth - margin * 2;
        const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
        pdf.addImage(imgData, 'PNG', margin, y, pdfWidth, pdfHeight);
        y += pdfHeight + 15; // Update y position to be below the image with padding

        const checkPageEnd = (currentY) => {
            if (currentY > pageHeight - margin) {
                pdf.addPage();
                return margin;
            }
            return currentY;
        };

        y = checkPageEnd(y); // Check if we need a new page for the text

        pdf.line(margin, y - 8, pageWidth - margin, y - 8);
        
        const lines = reportText.split('\n');
        const lineHeight = 5;
        const maxWidth = pageWidth - margin * 2;

        for (const line of lines) {
            y = checkPageEnd(y);
            // Clean emojis and trim whitespace
            const processedLine = line.replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '').trim();

            if (processedLine === '') {
                y += lineHeight;
                continue;
            }

            if (processedLine.startsWith('## ')) {
                y += lineHeight * 1.5;
                y = checkPageEnd(y);
                pdf.setFontSize(14);
                pdf.setFont('helvetica', 'bold');
                const title = processedLine.substring(3).replace(/\*\*/g, '');
                const splitTitle = pdf.splitTextToSize(title, maxWidth);
                pdf.text(splitTitle, margin, y);
                y += splitTitle.length * (lineHeight + 2);
            } else if (processedLine.startsWith('- ')) {
                pdf.setFontSize(11);
                const bulletPoint = '• ';
                const bulletWidth = pdf.getStringUnitWidth(bulletPoint) * pdf.getFontSize() / pdf.internal.scaleFactor;
                pdf.text(bulletPoint, margin + 5, y);
                
                const itemText = processedLine.substring(2).trim();
                y = addWrappedTextWithBold(pdf, itemText, margin + 5 + bulletWidth, y, maxWidth - 5 - bulletWidth, lineHeight);
                y += lineHeight;
            } else {
                pdf.setFontSize(11);
                y = addWrappedTextWithBold(pdf, processedLine, margin, y, maxWidth, lineHeight);
                y += lineHeight;
            }
        }
        
        pdf.save(`relatorio-ia-trades_${new Date().toISOString().split('T')[0]}.pdf`);

    } catch (error) {
        console.error("Error generating AI PDF report:", error);
        alert('Falha ao gerar o relatório com IA. Verifique o console para mais detalhes.');
    } finally {
        exportButton.textContent = 'Exportar Relatório IA';
        exportButton.removeAttribute('disabled');
    }
};

/**
 * @param {Event} event
 */
const handleImport = (event) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const text = e.target?.result;
        if (!text) {
            alert("O arquivo está vazio ou não pôde ser lido.");
            return;
        }

        try {
            const lines = text.trim().split(/\r?\n/);
            const headerLine = lines.shift();
            if (!headerLine) throw new Error("CSV inválido: Sem cabeçalhos.");
            
            const importHeaderMapping = {
                'Resultado Monetário/R$': 'result',
                'Resultado Pontos': 'points',
                'Contratos/Quantidade': 'lots'
            };

            const headers = headerLine.split(',').map(h => {
                const trimmedHeader = h.trim();
                return importHeaderMapping[trimmedHeader] || trimmedHeader;
            });

            const importedTrades = lines.map((line, index) => {
                const values = line.split(',');
                if (values.length !== headers.length) {
                    console.warn(`Pulando linha mal formada ${index + 2}: ${line}`);
                    return null;
                }
                const tradeObject = {};
                headers.forEach((header, i) => {
                    tradeObject[header] = values[i].trim();
                });
                
                return {
                    id: parseInt(tradeObject.id, 10),
                    asset: tradeObject.asset,
                    tradeNumber: parseInt(tradeObject.tradeNumber, 10),
                    side: tradeObject.side,
                    date: tradeObject.date,
                    lots: parseFloat(tradeObject.lots),
                    entryPrice: parseFloat(tradeObject.entryPrice),
                    exitPrice: parseFloat(tradeObject.exitPrice),
                    points: parseFloat(tradeObject.points),
                    result: parseFloat(tradeObject.result),
                    region: tradeObject.region,
                    structure: tradeObject.structure,
                    trigger: tradeObject.trigger,
                };
            }).filter((trade) => trade !== null && !isNaN(trade.id));

            const existingIds = new Set(trades.map(t => t.id));
            const newTrades = importedTrades.filter(t => !existingIds.has(t.id));

            if (newTrades.length > 0) {
                trades = [...trades, ...newTrades].sort((a, b) => a.id - b.id);
                saveState();
                if (googleAuthState.isSignedIn) {
                    syncToSheet({ silent: true });
                }
                render();
                alert(`${newTrades.length} nova(s) operação(ões) importada(s) com sucesso!`);
            } else {
                alert("Nenhuma nova operação encontrada no arquivo importado.");
            }
        } catch (error) {
            console.error("Erro ao importar CSV:", error);
            alert("Falha ao importar CSV. Verifique o formato do arquivo e o console para erros.");
        } finally {
            input.value = '';
        }
    };
    reader.onerror = () => {
        alert("Erro ao ler o arquivo.");
        input.value = '';
    };
    reader.readAsText(file);
};


const applyFilters = () => {
    return trades.filter(trade => {
        const assetMatch = !filters.asset || trade.asset.toLowerCase().includes(filters.asset.toLowerCase());
        const sideMatch = filters.side === 'Todos' || trade.side === filters.side;
        const dateMatch = !filters.date || trade.date === filters.date;
        const resultMatch = filters.result === 'Todos' || (filters.result === 'Gain' && trade.result > 0) || (filters.result === 'Loss' && trade.result <= 0);
        return assetMatch && sideMatch && dateMatch && resultMatch;
    });
};

/**
 * @param {Event} event
 */
const updateFilters = (event) => {
    const el = event.target;
    filters[el.name] = el.value;
    
    // Debounce text input to prevent re-render on every keystroke
    if (el.type === 'text') {
        debouncedRender();
    } else {
        render(); // Render immediately for selects and date picker
    }
};

// --- RENDERING ---
const renderAIInsightCard = () => {
    if (ai) {
        return `
            <div class="card ai-insight" aria-live="polite">
                <h3>💡 Insight da IA</h3>
                <div id="ai-insight-content">Registre uma operação para receber uma análise.</div>
            </div>
        `;
    }

    const promptMessage = aiInitializationError?.message.includes('inválida')
        ? 'A chave de API fornecida é inválida. Tente novamente.'
        : 'Para habilitar os recursos de IA, por favor, informe sua chave de API do Google Gemini abaixo.';
    
    return `
        <div class="card ai-insight">
            <h3>💡 Insight da IA</h3>
            <div id="ai-insight-content">
                <p style="color: var(--loss-color); margin-bottom: 0.5rem;"><strong>Funcionalidades de IA desativadas.</strong></p>
                <p style="font-size: 0.9rem; color: var(--text-secondary-color); margin-bottom: 1rem;">
                    ${promptMessage}
                </p>
                <form id="api-key-form" class="api-key-form" novalidate>
                    <label for="api-key-input" class="sr-only">Chave da API do Google Gemini</label>
                    <input type="password" id="api-key-input" name="api-key-input" placeholder="Insira sua chave de API válida do Gemini" required>
                    <button type="submit" class="btn btn-secondary">Validar e Usar Chave</button>
                    <div id="api-key-status" class="api-key-status" aria-live="assertive"></div>
                </form>
            </div>
        </div>
    `;
};

function render() {
    const filteredTrades = applyFilters();
    const today = new Date().toISOString().split('T')[0];

    appRoot.innerHTML = `
        <div class="left-panel">
            <div class="card">
                <h2>Registrar Operação</h2>
                <form id="trade-form" novalidate>
                    ${renderFormFields( { date: today, asset: 'WDOFUT', lots: 1 } )}
                    <button type="submit" class="btn btn-primary">Adicionar Operação</button>
                </form>
            </div>
            ${renderAIInsightCard()}
        </div>
        <div class="right-panel">
            <div class="card" id="performance-dashboard-card">
                 <h2>Dashboard de Performance</h2>
                 ${renderDashboardStats(filteredTrades)}
                 <div class="charts">
                    <div><canvas id="pnlChart" role="img" aria-label="Gráfico de linha do resultado acumulado"></canvas></div>
                    <div><canvas id="winLossChart" role="img" aria-label="Gráfico de rosca da taxa de acertos e erros"></canvas></div>
                    <div><canvas id="triggerChart" role="img" aria-label="Gráfico de barras da taxa de acerto por gatilho"></canvas></div>
                 </div>
            </div>
            <div class="card">
                <h2>Histórico de Operações</h2>
                ${renderFilters()}
                <div class="trade-history">
                    ${renderTradeHistory(filteredTrades)}
                </div>
                <div class="actions-footer">
                    <button id="export-pdf" class="btn btn-secondary" ${!ai ? 'disabled title="Funcionalidade de IA desativada. Forneça uma chave de API."' : ''}>Exportar Relatório IA</button>
                    <button id="export-csv" class="btn btn-secondary">Exportar CSV</button>
                    <label for="import-csv-input" class="btn btn-secondary">Importar CSV</label>
                    <input type="file" id="import-csv-input" accept=".csv" style="display: none;">
                </div>
            </div>
        </div>
        <div id="modal-container">
            ${renderEditModal()}
            ${renderDeleteModal()}
        </div>
    `;
    renderGoogleAuthHeader();
    renderCharts(filteredTrades);
    attachEventListeners();
}

const renderGoogleAuthHeader = () => {
    const container = document.getElementById('google-auth-container');
    if (!container) return;

    const isConnected = googleAuthState.isSignedIn;
    const disabled = !isGapiReady || !isGisReady;
    let content = '';

    if (disabled) {
        content = `<p class="status-text">Inicializando...</p>`;
    } else if (isConnected) {
        content = `
            <span class="status-text" title="Conectado ao Google Sheets">${googleAuthState.user}</span>
            <button id="sync-sheets" class="btn btn-primary" title="Sincronizar com Google Sheets">Sincronizar</button>
            <button id="signout-sheets" class="btn btn-secondary" title="Desconectar do Google">Desconectar</button>
        `;
    } else {
        content = `
            <a href="https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit" target="_blank" rel="noopener noreferrer" class="status-text" style="text-decoration: none; color: var(--text-secondary-color);" title="Ver planilha de destino">Ver Planilha</a>
            <button id="auth-sheets" class="btn btn-secondary" title="Conectar com Google Sheets para sincronizar">Conectar ao Google</button>
        `;
    }
    container.innerHTML = content;
};


/**
 * @param {Partial<Trade>} tradeData
 */
const renderFormFields = (tradeData) => {
    return `
        <div class="form-group">
            <label for="asset">Ativo</label>
            <input type="text" id="asset" name="asset" required value="${tradeData.asset || ''}">
            <div class="error-message" id="asset-error"></div>
        </div>
        <div class="form-group">
            <label for="date">Data</label>
            <input type="date" id="date" name="date" required value="${tradeData.date || ''}">
            <div class="error-message" id="date-error"></div>
        </div>
        <div class="form-columns">
            <div class="form-group">
                <label for="side">Lado</label>
                <select id="side" name="side">
                    <option value="Compra" ${tradeData.side === 'Compra' ? 'selected' : ''}>Compra</option>
                    <option value="Venda" ${tradeData.side === 'Venda' ? 'selected' : ''}>Venda</option>
                </select>
            </div>
            <div class="form-group">
                <label for="lots">Lotes (Qtd.)</label>
                <input type="text" inputmode="decimal" id="lots" name="lots" required value="${tradeData.lots || 1}">
                <div class="error-message" id="lots-error"></div>
            </div>
        </div>
        <div class="form-columns">
            <div class="form-group">
                <label for="entry-price">Preço Entrada</label>
                <input type="text" inputmode="decimal" id="entry-price" name="entry-price" required step="0.5" value="${tradeData.entryPrice || ''}">
                <div class="error-message" id="entry-price-error"></div>
            </div>
            <div class="form-group">
                <label for="exit-price">Preço Saída</label>
                <input type="text" inputmode="decimal" id="exit-price" name="exit-price" required step="0.5" value="${tradeData.exitPrice || ''}">
                <div class="error-message" id="exit-price-error"></div>
            </div>
        </div>
        <div class="form-group">
            <label for="regions">Região</label>
            <input list="regions-list" id="regions" name="regions" required value="${tradeData.region || ''}">
            <datalist id="regions-list">
                ${regOptions.regions.map(o => `<option value="${o}">`).join('')}
            </datalist>
            <div class="error-message" id="regions-error"></div>
        </div>
        <div class="form-group">
            <label for="structures">Estrutura</label>
            <input list="structures-list" id="structures" name="structures" required value="${tradeData.structure || ''}">
            <datalist id="structures-list">
                ${regOptions.structures.map(o => `<option value="${o}">`).join('')}
            </datalist>
            <div class="error-message" id="structures-error"></div>
        </div>
        <div class="form-group">
            <label for="triggers">Gatilho</label>
            <input list="triggers-list" id="triggers" name="triggers" required value="${tradeData.trigger || ''}">
            <datalist id="triggers-list">
                ${regOptions.triggers.map(o => `<option value="${o}">`).join('')}
            </datalist>
            <div class="error-message" id="triggers-error"></div>
        </div>
        <div class="form-group">
            <label for="notes">Notas Adicionais (IA)</label>
            <textarea id="notes" name="notes" rows="4">${tradeData.notes || ''}</textarea>
        </div>
    `;
};


const renderEditModal = () => {
    if (!editingTrade) return '';
    const mainContent = document.querySelector('main');
    if (mainContent) mainContent.setAttribute('aria-hidden', 'true');

    return `
        <div class="modal-overlay">
            <div class="modal-content card" role="dialog" aria-modal="true" aria-labelledby="edit-modal-title">
                <div class="modal-header">
                    <h2 id="edit-modal-title">Editar Operação</h2>
                    <button class="btn-close-modal" aria-label="Fechar modal">&times;</button>
                </div>
                <form id="edit-trade-form" novalidate>
                    ${renderFormFields(editingTrade)}
                    <button type="submit" class="btn btn-primary">Salvar Alterações</button>
                </form>
            </div>
        </div>
    `;
};

const renderDeleteModal = () => {
    if (deletingTradeId === null) return '';
    const tradeToDelete = trades.find(t => t.id === deletingTradeId);
    if (!tradeToDelete) return '';
    const mainContent = document.querySelector('main');
    if (mainContent) mainContent.setAttribute('aria-hidden', 'true');

    return `
        <div class="modal-overlay">
            <div class="modal-content card" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
                <div class="modal-header">
                    <h2 id="delete-modal-title">Confirmar Exclusão</h2>
                    <button class="btn-close-modal" aria-label="Fechar modal">&times;</button>
                </div>
                <div class="modal-body">
                    <p>Você tem certeza que deseja excluir a operação #${tradeToDelete.tradeNumber} (${tradeToDelete.asset})?</p>
                    <p><strong>Esta ação não pode ser desfeita.</strong></p>
                </div>
                <div class="modal-actions">
                    <button class="btn btn-secondary btn-cancel-delete">Cancelar</button>
                    <button class="btn btn-danger btn-confirm-delete">Excluir</button>
                </div>
            </div>
        </div>
    `;
};

/**
 * @param {Trade[]} data
 */
const renderDashboardStats = (data) => {
    const totalResult = data.reduce((acc, t) => acc + t.result, 0);
    const totalPoints = data.reduce((acc, t) => acc + t.points, 0);
    const gains = data.filter(t => t.result > 0).length;
    const totalTrades = data.length;
    const winRate = totalTrades > 0 ? (gains / totalTrades) * 100 : 0;

    return `
        <div class="dashboard">
            <div class="stat-card">
                <h3>Resultado (R$)</h3>
                <p class="${totalResult >= 0 ? 'gain' : 'loss'}">${totalResult.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
            </div>
            <div class="stat-card">
                <h3>Total de Pontos</h3>
                <p class="${totalPoints >= 0 ? 'gain' : 'loss'}">${totalPoints.toFixed(2)}</p>
            </div>
            <div class="stat-card">
                <h3>Taxa de Acerto</h3>
                <p>${winRate.toFixed(1)}%</p>
            </div>
            <div class="stat-card">
                <h3>Nº de Operações</h3>
                <p>${totalTrades}</p>
            </div>
        </div>
    `;
};


const renderFilters = () => {
    return `
        <div class="filters">
            <input type="text" name="asset" placeholder="Filtrar por Ativo..." value="${filters.asset}" class="filter-input">
            <select name="side" class="filter-input">
                <option value="Todos" ${filters.side === 'Todos' ? 'selected' : ''}>Todos Lados</option>
                <option value="Compra" ${filters.side === 'Compra' ? 'selected' : ''}>Compra</option>
                <option value="Venda" ${filters.side === 'Venda' ? 'selected' : ''}>Venda</option>
            </select>
            <input type="date" name="date" value="${filters.date}" class="filter-input">
            <select name="result" class="filter-input">
                <option value="Todos" ${filters.result === 'Todos' ? 'selected' : ''}>Todos Resultados</option>
                <option value="Gain" ${filters.result === 'Gain' ? 'selected' : ''}>Gain</option>
                <option value="Loss" ${filters.result === 'Loss' ? 'selected' : ''}>Loss</option>
            </select>
        </div>
    `;
}

/**
 * @param {Trade} trade
 * @returns {{ status: 'Gain' | 'Loss' | 'Zero a Zero', className: 'gain' | 'loss' | 'zero' }}
 */
const getTradeStatus = (trade) => {
    if (trade.result > 0) return { status: 'Gain', className: 'gain' };
    if (trade.result < 0) return { status: 'Loss', className: 'loss' };
    return { status: 'Zero a Zero', className: 'zero' };
};

/**
 * @param {Trade[]} data
 */
const renderTradeHistory = (data) => {
    const hasActiveFilters = filters.asset !== '' || filters.side !== 'Todos' || filters.date !== '' || filters.result !== 'Todos';
    const emptyMessage = hasActiveFilters 
        ? 'Nenhuma operação encontrada para os filtros aplicados.' 
        : 'Nenhuma operação registrada.';

    const sortedData = [...data].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return `
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>Data</th>
                    <th>Ativo</th>
                    <th>Lado</th>
                    <th>Lotes</th>
                    <th>Entrada</th>
                    <th>Saída</th>
                    <th>Gatilho</th>
                    <th>Pontos</th>
                    <th>Resultado (R$)</th>
                    <th>Situação</th>
                    <th>Ações</th>
                </tr>
            </thead>
            <tbody>
                ${
                    sortedData.length > 0
                    ? sortedData.map(trade => {
                        const { status, className } = getTradeStatus(trade);
                        const tradeIdentifier = `operação ${trade.tradeNumber} do ativo ${trade.asset}`;
                        return `
                        <tr>
                            <td>${trade.tradeNumber}</td>
                            <td>${new Date(trade.date + 'T00:00:00').toLocaleDateString('pt-BR')}</td>
                            <td>${trade.asset}</td>
                            <td class="side-${trade.side === 'Compra' ? 'buy' : 'sell'}">${trade.side}</td>
                            <td>${trade.lots}</td>
                            <td>${trade.entryPrice.toFixed(2)}</td>
                            <td>${trade.exitPrice.toFixed(2)}</td>
                            <td>${trade.trigger}</td>
                            <td class="${trade.points >= 0 ? 'gain' : 'loss'}">${trade.points.toFixed(2)}</td>
                            <td class="${trade.result >= 0 ? 'gain' : 'loss'}">${trade.result.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td class="${className}">${status}</td>
                            <td class="actions-cell">
                                <button class="btn-icon btn-edit" data-id="${trade.id}" title="Editar" aria-label="Editar ${tradeIdentifier}">✏️</button>
                                <button class="btn-icon btn-delete" data-id="${trade.id}" title="Excluir" aria-label="Excluir ${tradeIdentifier}">🗑️</button>
                            </td>
                        </tr>
                    `}).join('')
                    : `<tr><td colspan="12" class="empty-state">${emptyMessage}</td></tr>`
                }
            </tbody>
        </table>
    `;
};

/**
 * @param {Trade[]} data
 */
const renderCharts = (data) => {
    Object.values(charts).forEach(chart => chart.destroy());

    const pnlCtx = document.getElementById('pnlChart');
    if (pnlCtx) {
        let accumulatedPnl = 0;
        const pnlData = data.map(trade => {
            accumulatedPnl += trade.result;
            return accumulatedPnl;
        });
        charts.pnlChart = new Chart(pnlCtx, {
            type: 'line',
            data: { labels: data.map((_, i) => `Op ${i + 1}`), datasets: [{ label: 'Resultado Acumulado (R$)', data: pnlData, borderColor: '#00aaff', backgroundColor: 'rgba(0, 170, 255, 0.1)', fill: true, tension: 0.1 }] },
            options: { responsive: true, maintainAspectRatio: false }
        });
    }

    const winLossCtx = document.getElementById('winLossChart');
    if (winLossCtx) {
        const gains = data.filter(t => t.result > 0).length;
        const losses = data.length - gains;
        charts.winLossChart = new Chart(winLossCtx, {
            type: 'doughnut',
            data: { labels: ['Gains', 'Losses'], datasets: [{ data: [gains, losses], backgroundColor: ['#26a69a', '#ef5350'] }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' } } }
        });
    }
    
    const triggerCtx = document.getElementById('triggerChart');
    if (triggerCtx) {
        const triggerStats = {};
        data.forEach(trade => {
            if (!triggerStats[trade.trigger]) triggerStats[trade.trigger] = { gains: 0, total: 0 };
            triggerStats[trade.trigger].total++;
            if (trade.result > 0) triggerStats[trade.trigger].gains++;
        });
        const labels = Object.keys(triggerStats);
        const winRates = labels.map(t => (triggerStats[t].gains / triggerStats[t].total) * 100);

        charts.triggerChart = new Chart(triggerCtx, {
            type: 'bar',
            data: { labels, datasets: [{ label: 'Taxa de Acerto por Gatilho (%)', data: winRates, backgroundColor: '#0077b6' }] },
            options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y' }
        });
    }
};


const attachEventListeners = () => {
    document.getElementById('trade-form')?.addEventListener('submit', addTrade);
    document.getElementById('export-pdf')?.addEventListener('click', exportToPDF);
    document.getElementById('export-csv')?.addEventListener('click', exportToCSV);
    document.getElementById('import-csv-input')?.addEventListener('change', handleImport);
    document.getElementById('api-key-form')?.addEventListener('submit', handleApiKeySubmit);
    
    document.querySelectorAll('.filter-input').forEach(input => {
        input.addEventListener('input', updateFilters);
        input.addEventListener('change', updateFilters);
    });

    document.querySelector('.trade-history')?.addEventListener('click', (e) => {
        const target = e.target;
        const editButton = target.closest('.btn-edit');
        const deleteButton = target.closest('.btn-delete');
        if (editButton) {
            const id = parseInt(editButton.getAttribute('data-id'), 10);
            openEditModal(id);
        }
        if (deleteButton) {
            const id = parseInt(deleteButton.getAttribute('data-id'), 10);
            openDeleteModal(id);
        }
    });

    const modal = document.querySelector('.modal-overlay');
    if (modal) {
        modal.querySelector('.btn-close-modal')?.addEventListener('click', editingTrade ? closeEditModal : closeDeleteModal);
        modal.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                editingTrade ? closeEditModal() : closeDeleteModal();
            }
        });
    }

    if (editingTrade) {
        document.getElementById('edit-trade-form')?.addEventListener('submit', updateTrade);
    }

    if (deletingTradeId !== null) {
        document.querySelector('.btn-confirm-delete')?.addEventListener('click', confirmDelete);
        document.querySelector('.btn-cancel-delete')?.addEventListener('click', closeDeleteModal);
    }

    // Google Sheets listeners
    document.getElementById('auth-sheets')?.addEventListener('click', handleAuthClick);
    document.getElementById('signout-sheets')?.addEventListener('click', handleSignoutClick);
    document.getElementById('sync-sheets')?.addEventListener('click', () => syncToSheet());
};

const loadGoogleApiScripts = () => {
    const gisScript = document.createElement('script');
    gisScript.src = 'https://accounts.google.com/gsi/client';
    gisScript.async = true;
    gisScript.defer = true;
    gisScript.onload = gisLoaded;
    document.head.appendChild(gisScript);

    const gapiScript = document.createElement('script');
    gapiScript.src = 'https://apis.google.com/js/api.js';
    gapiScript.async = true;
    gapiScript.defer = true;
    gapiScript.onload = gapiLoaded;
    document.head.appendChild(gapiScript);
};

// --- APP START ---
const initializeApp = async () => {
    loadState();
    loadGoogleApiScripts();
    
    await attemptAiInitialization();

    render();
};

initializeApp();