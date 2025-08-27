/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI } from "@google/genai";
import { marked } from "marked";
import { Chart, registerables } from "chart.js";

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

// --- INITIALIZATION & CONFIG ---
Chart.register(...registerables);
// FIX: The API key must be obtained from `process.env.API_KEY`.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
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

/**
 * @param {Trade} trade
 */
const getAIInsight = async (trade) => {
    const insightContainer = document.getElementById('ai-insight-content');
    if (!insightContainer) return;
    insightContainer.parentElement.classList.add('loading');
    insightContainer.innerHTML = 'Analisando sua operação...';

    const prompt = `
        Análise de Trade Rápida:
        - Ativo: ${trade.asset}
        - Lado: ${trade.side}
        - Lotes: ${trade.lots}
        - Preço de Entrada: ${trade.entryPrice}
        - Preço de Saída: ${trade.exitPrice}
        - Resultado: ${trade.result > 0 ? 'Gain' : 'Loss'} de R$ ${Math.abs(trade.result).toFixed(2)} (${trade.points} pontos)
        - Estratégia REG: Região (${trade.region}), Estrutura (${trade.structure}), Gatilho (${trade.trigger})

        Com base nesses dados, forneça um insight para o trader. Seja amigável, direto e ajude-o a refletir sobre a operação.
        Foque em um ponto positivo se foi gain, ou um ponto de atenção se foi loss.
        A resposta deve ter no máximo 45 segundos de leitura. Use markdown para formatação.
    `;
    
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });
        insightContainer.innerHTML = await marked.parse(response.text);
    } catch (error) {
        console.error("Error fetching AI insight:", error);
        insightContainer.innerHTML = 'Não foi possível obter o insight. Tente novamente mais tarde.';
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
 * @param {SubmitEvent} event
 */
const addTrade = (event) => {
    event.preventDefault();
    const form = event.target;
    const formData = new FormData(form);
    
    const side = formData.get('side');
    const lots = parseFloat(formData.get('lots'));
    const entryPrice = parseFloat(formData.get('entry-price'));
    const exitPrice = parseFloat(formData.get('exit-price'));
    const { points, result } = calculateTradeMetrics(side, lots, entryPrice, exitPrice);

    /** @type {Trade} */
    const newTrade = {
        id: Date.now(),
        asset: formData.get('asset'),
        tradeNumber: trades.length + 1,
        side,
        date: formData.get('date'),
        lots,
        entryPrice,
        exitPrice,
        points,
        result,
        region: formData.get('regions'),
        structure: formData.get('structures'),
        trigger: formData.get('triggers'),
    };
    
    trades.push(newTrade);
    updateRegOptionsIfNeeded(newTrade);
    saveState();
    
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
    const formData = new FormData(form);

    const side = formData.get('side');
    const lots = parseFloat(formData.get('lots'));
    const entryPrice = parseFloat(formData.get('entry-price'));
    const exitPrice = parseFloat(formData.get('exit-price'));
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
    const headers = Object.keys(trades[0]).join(',');
    const rows = trades.map(trade => Object.values(trade).join(',')).join('\n');
    const csvContent = `data:text/csv;charset=utf-8,${headers}\n${rows}`;
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `trades_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
            const headers = lines.shift()?.split(',');
            if (!headers || headers.length < 1) throw new Error("CSV inválido: Sem cabeçalhos.");

            const importedTrades = lines.map((line, index) => {
                const values = line.split(',');
                if (values.length !== headers.length) {
                    console.warn(`Pulando linha mal formada ${index + 2}: ${line}`);
                    return null;
                }
                const tradeObject = {};
                headers.forEach((header, i) => {
                    tradeObject[header.trim()] = values[i].trim();
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
function render() {
    const filteredTrades = applyFilters();
    const today = new Date().toISOString().split('T')[0];

    appRoot.innerHTML = `
        <div class="left-panel">
            <div class="card">
                <h2>Registrar Operação</h2>
                <form id="trade-form">
                    ${renderFormFields( { date: today, asset: 'WDOFUT', lots: 1 } )}
                    <button type="submit" class="btn btn-primary">Adicionar Operação</button>
                </form>
            </div>
             <div class="card ai-insight" aria-live="polite">
                <h3>💡 Insight da IA</h3>
                <div id="ai-insight-content">Registre uma operação para receber uma análise.</div>
            </div>
        </div>
        <div class="right-panel">
            <div class="card">
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
    renderCharts(filteredTrades);
    attachEventListeners();
}

/**
 * @param {Partial<Trade>} tradeData
 */
const renderFormFields = (tradeData) => {
    return `
        <div class="form-group">
            <label for="asset">Ativo</label>
            <input type="text" id="asset" name="asset" required value="${tradeData.asset || ''}">
        </div>
        <div class="form-group">
            <label for="date">Data</label>
            <input type="date" id="date" name="date" required value="${tradeData.date || ''}">
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
                <input type="number" id="lots" name="lots" required min="1" value="${tradeData.lots || 1}">
            </div>
        </div>
        <div class="form-columns">
            <div class="form-group">
                <label for="entry-price">Preço Entrada</label>
                <input type="number" id="entry-price" name="entry-price" required step="0.5" value="${tradeData.entryPrice || ''}">
            </div>
            <div class="form-group">
                <label for="exit-price">Preço Saída</label>
                <input type="number" id="exit-price" name="exit-price" required step="0.5" value="${tradeData.exitPrice || ''}">
            </div>
        </div>
        <div class="form-group">
            <label for="regions">Região</label>
            <input list="regions-list" id="regions" name="regions" required value="${tradeData.region || ''}">
            <datalist id="regions-list">
                ${regOptions.regions.map(o => `<option value="${o}">`).join('')}
            </datalist>
        </div>
        <div class="form-group">
            <label for="structures">Estrutura</label>
            <input list="structures-list" id="structures" name="structures" required value="${tradeData.structure || ''}">
            <datalist id="structures-list">
                ${regOptions.structures.map(o => `<option value="${o}">`).join('')}
            </datalist>
        </div>
        <div class="form-group">
            <label for="triggers">Gatilho</label>
            <input list="triggers-list" id="triggers" name="triggers" required value="${tradeData.trigger || ''}">
            <datalist id="triggers-list">
                ${regOptions.triggers.map(o => `<option value="${o}">`).join('')}
            </datalist>
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
                <form id="edit-trade-form">
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
                    data.length > 0
                    ? data.map(trade => {
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
    document.getElementById('export-csv')?.addEventListener('click', exportToCSV);
    document.getElementById('import-csv-input')?.addEventListener('change', handleImport);
    
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
};

// --- APP START ---
loadState();
render();
