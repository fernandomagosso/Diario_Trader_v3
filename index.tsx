/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI } from "@google/genai";
import { marked } from "marked";
import { Chart, registerables } from "chart.js";
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';


// --- TYPES AND INTERFACES ---
interface Trade {
    id: number;
    asset: string;
    tradeNumber: number;
    side: 'Compra' | 'Venda';
    date: string; // Stored as YYYY-MM-DD
    lots: number;
    entryPrice: number;
    exitPrice: number;
    points: number;
    result: number;
    region: string;
    structure: string;
    trigger: string;
}

interface RegOptions {
    regions: string[];
    structures: string[];
    triggers: string[];
}

interface Filters {
    asset: string;
    side: 'Todos' | 'Compra' | 'Venda';
    date: string;
    result: 'Todos' | 'Gain' | 'Loss';
}

// --- UTILITIES ---
const debounce = <F extends (...args: any[]) => any>(func: F, waitFor: number) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return (...args: Parameters<F>): void => {
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
const appRoot = document.getElementById('app-root')!;
let trades: Trade[] = [];
let editingTrade: Trade | null = null;
let deletingTradeId: number | null = null;
let filters: Filters = { asset: '', side: 'Todos', date: '', result: 'Todos' };
let regOptions: RegOptions = {
    regions: ['Região Barata', 'Região Cara', 'Consolidação'],
    structures: ['A-B-C de Alta', 'A-B-C de Baixa'],
    triggers: ['Cadeado de Alta', 'Cadeado de Baixa', '2-2-1', 'Pivot Disfarçado']
};
let charts: { [key: string]: Chart } = {};
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
const updateRegOptionsIfNeeded = (tradeData: { region: string, structure: string, trigger: string }) => {
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


const getAIInsight = async (trade: Trade) => {
    const insightContainer = document.getElementById('ai-insight-content')!;
    insightContainer.parentElement!.classList.add('loading');
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
        insightContainer.parentElement!.classList.remove('loading');
    }
};

const calculateTradeMetrics = (side: 'Compra' | 'Venda', lots: number, entryPrice: number, exitPrice: number) => {
    const points = side === 'Compra' ? exitPrice - entryPrice : entryPrice - exitPrice;
    const result = points * 10 * lots; // Assuming WDOFUT logic for simplicity
    return { points: parseFloat(points.toFixed(2)), result: parseFloat(result.toFixed(2)) };
}

const addTrade = (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const formData = new FormData(form);
    
    const side = formData.get('side') as 'Compra' | 'Venda';
    const lots = parseFloat(formData.get('lots') as string);
    const entryPrice = parseFloat(formData.get('entry-price') as string);
    const exitPrice = parseFloat(formData.get('exit-price') as string);
    const { points, result } = calculateTradeMetrics(side, lots, entryPrice, exitPrice);

    const newTrade: Trade = {
        id: Date.now(),
        asset: formData.get('asset') as string,
        tradeNumber: trades.length + 1,
        side,
        date: formData.get('date') as string,
        lots,
        entryPrice,
        exitPrice,
        points,
        result,
        region: formData.get('regions') as string,
        structure: formData.get('structures') as string,
        trigger: formData.get('triggers') as string,
    };
    
    trades.push(newTrade);
    updateRegOptionsIfNeeded(newTrade);
    saveState();
    
    const assetToKeep = (form.elements.namedItem('asset') as HTMLInputElement).value;
    const dateToKeep = (form.elements.namedItem('date') as HTMLInputElement).value;
    render();
    const newForm = document.getElementById('trade-form') as HTMLFormElement;
    if (newForm) {
        (newForm.elements.namedItem('asset') as HTMLInputElement).value = assetToKeep;
        (newForm.elements.namedItem('date') as HTMLInputElement).value = dateToKeep;
        (newForm.elements.namedItem('entry-price') as HTMLInputElement).focus();
    }

    getAIInsight(newTrade);
};

const updateTrade = (event: SubmitEvent) => {
    event.preventDefault();
    if (!editingTrade) return;

    const form = event.target as HTMLFormElement;
    const formData = new FormData(form);

    const side = formData.get('side') as 'Compra' | 'Venda';
    const lots = parseFloat(formData.get('lots') as string);
    const entryPrice = parseFloat(formData.get('entry-price') as string);
    const exitPrice = parseFloat(formData.get('exit-price') as string);
    const { points, result } = calculateTradeMetrics(side, lots, entryPrice, exitPrice);

    const updatedTrade: Trade = {
        ...editingTrade,
        asset: formData.get('asset') as string,
        side,
        date: formData.get('date') as string,
        lots,
        entryPrice,
        exitPrice,
        points,
        result,
        region: formData.get('regions') as string,
        structure: formData.get('structures') as string,
        trigger: formData.get('triggers') as string,
    };
    
    const tradeIndex = trades.findIndex(t => t.id === editingTrade!.id);
    if (tradeIndex !== -1) {
        trades[tradeIndex] = updatedTrade;
    }

    updateRegOptionsIfNeeded(updatedTrade);
    saveState();
    closeEditModal();
};

const openDeleteModal = (id: number) => {
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

const openEditModal = (id: number) => {
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

const exportToPDF = async () => {
    const dashboardCard = document.getElementById('performance-dashboard-card');
    const exportButton = document.getElementById('export-pdf');
    if (!dashboardCard || !exportButton) {
        console.error('Dashboard card or export button not found');
        return;
    }

    exportButton.textContent = 'Gerando PDF...';
    exportButton.setAttribute('disabled', 'true');

    try {
        const canvas = await html2canvas(dashboardCard, {
            scale: 2, // For better resolution
            backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--surface-color').trim() || '#1e1e1e',
            logging: false,
            useCORS: true
        });
        const imgData = canvas.toDataURL('image/png');
        const pdf = new jsPDF('p', 'mm', 'a4');
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const imgProps = canvas;
        const imgWidth = pdfWidth - 20; // 10mm margins
        const imgHeight = (imgProps.height * imgWidth) / imgProps.width;

        pdf.addImage(imgData, 'PNG', 10, 10, imgWidth, imgHeight);
        pdf.save(`dashboard-performance_${new Date().toISOString().split('T')[0]}.pdf`);
    } catch (error) {
        console.error("Error generating PDF:", error);
        alert('Falha ao gerar o PDF. Verifique o console para mais detalhes.');
    } finally {
        exportButton.textContent = 'Exportar PDF';
        exportButton.removeAttribute('disabled');
    }
};

const handleImport = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const text = e.target?.result as string;
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
                const tradeObject: { [key: string]: any } = {};
                headers.forEach((header, i) => {
                    tradeObject[header.trim()] = values[i].trim();
                });
                
                return {
                    id: parseInt(tradeObject.id, 10),
                    asset: tradeObject.asset,
                    tradeNumber: parseInt(tradeObject.tradeNumber, 10),
                    side: tradeObject.side as 'Compra' | 'Venda',
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
            }).filter((trade): trade is Trade => trade !== null && !isNaN(trade.id));

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


const applyFilters = (): Trade[] => {
    return trades.filter(trade => {
        const assetMatch = !filters.asset || trade.asset.toLowerCase().includes(filters.asset.toLowerCase());
        const sideMatch = filters.side === 'Todos' || trade.side === filters.side;
        const dateMatch = !filters.date || trade.date === filters.date;
        const resultMatch = filters.result === 'Todos' || (filters.result === 'Gain' && trade.result > 0) || (filters.result === 'Loss' && trade.result <= 0);
        return assetMatch && sideMatch && dateMatch && resultMatch;
    });
};

const updateFilters = (event: Event) => {
    const el = event.target as HTMLInputElement | HTMLSelectElement;
    (filters as any)[el.name] = el.value;
    
    // Debounce text input to prevent re-render on every keystroke
    if (el.type === 'text') {
        debouncedRender();
    } else {
        render(); // Render immediately for selects and date picker
    }
};

// --- RENDERING ---
// FIX: Converted 'render' from a const arrow function to a standard function declaration.
// This hoists the function, making it available for the 'debouncedRender' constant initialization
// and fixing the "used before declaration" error.
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
                    <button id="export-pdf" class="btn btn-secondary">Exportar PDF</button>
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

const renderFormFields = (tradeData: Partial<Trade>) => {
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

const renderDashboardStats = (data: Trade[]) => {
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

const getTradeStatus = (trade: Trade): { status: 'Gain' | 'Loss' | 'Zero a Zero', className: 'gain' | 'loss' | 'zero' } => {
    if (trade.result > 0) return { status: 'Gain', className: 'gain' };
    if (trade.result < 0) return { status: 'Loss', className: 'loss' };
    return { status: 'Zero a Zero', className: 'zero' };
};

const renderTradeHistory = (data: Trade[]) => {
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

const renderCharts = (data: Trade[]) => {
    Object.values(charts).forEach(chart => chart.destroy());

    const pnlCtx = document.getElementById('pnlChart') as HTMLCanvasElement;
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

    const winLossCtx = document.getElementById('winLossChart') as HTMLCanvasElement;
    if (winLossCtx) {
        const gains = data.filter(t => t.result > 0).length;
        const losses = data.length - gains;
        charts.winLossChart = new Chart(winLossCtx, {
            type: 'doughnut',
            data: { labels: ['Gains', 'Losses'], datasets: [{ data: [gains, losses], backgroundColor: ['#26a69a', '#ef5350'] }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' } } }
        });
    }
    
    const triggerCtx = document.getElementById('triggerChart') as HTMLCanvasElement;
    if (triggerCtx) {
        const triggerStats: { [key: string]: { gains: number; total: number } } = {};
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
    document.getElementById('export-pdf')?.addEventListener('click', exportToPDF);
    document.getElementById('import-csv-input')?.addEventListener('change', handleImport);
    
    document.querySelectorAll('.filter-input').forEach(input => {
        input.addEventListener('input', updateFilters);
        input.addEventListener('change', updateFilters);
    });

    document.querySelector('.trade-history')?.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const editButton = target.closest('.btn-edit');
        const deleteButton = target.closest('.btn-delete');
        if (editButton) {
            const id = parseInt(editButton.getAttribute('data-id')!, 10);
            openEditModal(id);
        }
        if (deleteButton) {
            const id = parseInt(deleteButton.getAttribute('data-id')!, 10);
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