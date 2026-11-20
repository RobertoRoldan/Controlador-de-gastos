/**
 * =====================================================================
 * GEMINI ASSISTANT MODULE - FinanzasRoldan
 * Integración oficial con la API de Google Gemini para consultas
 * financieras en lenguaje natural con cálculo exacto sobre datos reales.
 * Incluye auto-detección dinámica de modelos mediante models.list.
 * =====================================================================
 */

(function (window) {
    'use strict';

    // Constantes de configuración y almacenamiento local seguro
    const STORAGE_API_KEY = 'finanzas_roldan_gemini_api_key';
    const STORAGE_MODEL = 'finanzas_roldan_gemini_model';
    const STORAGE_AVAILABLE_MODELS = 'finanzas_roldan_gemini_models_list';
    const DEFAULT_MODEL = 'auto'; // 'auto' activa la selección inteligente del modelo vigente
    const BASELINE_FALLBACK_MODEL = 'gemini-2.0-flash';

    // Estado interno del asistente en memoria
    let isRequestInProgress = false;
    let chatHistory = [];
    let discoveredModelsCache = null;

    /**
     * Obtiene la clave de API activa:
     * 1. Prioridad: localStorage del navegador del cliente
     * 2. Fallback: Configuración privada sincronizada en Supabase (userConfig)
     */
    function getApiKey() {
        const localKey = localStorage.getItem(STORAGE_API_KEY);
        if (localKey && localKey.trim()) {
            return localKey.trim();
        }

        // Intento desde userConfig de Supabase si el usuario está autenticado
        if (window.getAppData && typeof window.getAppData === 'function') {
            const app = window.getAppData();
            if (app && app.userConfig && app.userConfig.gemini_api_key) {
                const cloudKey = String(app.userConfig.gemini_api_key).trim();
                if (cloudKey) {
                    localStorage.setItem(STORAGE_API_KEY, cloudKey);
                    return cloudKey;
                }
            }
        }
        return '';
    }

    /**
     * Guarda la clave de API en el cliente y opcionalmente en Supabase user_config
     */
    async function saveApiKey(newKey, syncWithCloud = true) {
        const cleanedKey = (newKey || '').trim();
        if (!cleanedKey) {
            throw new Error('La clave de API no puede estar vacía.');
        }

        localStorage.setItem(STORAGE_API_KEY, cleanedKey);

        if (syncWithCloud && window.getAppData && typeof window.getAppData === 'function') {
            const app = window.getAppData();
            if (app && app.userConfig && app.currentUser) {
                app.userConfig.gemini_api_key = cleanedKey;
                if (typeof app.saveConfigToSupabase === 'function') {
                    await app.saveConfigToSupabase();
                }
            }
        }

        updateUiKeyStatus();
        return true;
    }

    /**
     * Elimina la clave de API del cliente y de Supabase
     */
    async function removeApiKey() {
        localStorage.removeItem(STORAGE_API_KEY);
        localStorage.removeItem(STORAGE_AVAILABLE_MODELS);
        discoveredModelsCache = null;

        if (window.getAppData && typeof window.getAppData === 'function') {
            const app = window.getAppData();
            if (app && app.userConfig) {
                delete app.userConfig.gemini_api_key;
                if (typeof app.saveConfigToSupabase === 'function') {
                    await app.saveConfigToSupabase();
                }
            }
        }

        updateUiKeyStatus();
    }

    /**
     * Obtiene el modelo de Gemini seleccionado ('auto' o ID concreto)
     */
    function getSelectedModel() {
        return localStorage.getItem(STORAGE_MODEL) || DEFAULT_MODEL;
    }

    /**
     * Guarda el modelo seleccionado
     */
    function setSelectedModel(modelName) {
        localStorage.setItem(STORAGE_MODEL, modelName || DEFAULT_MODEL);
    }

    /**
     * Consulta el endpoint oficial models.list de Google Gemini
     * para descubrir los modelos vigentes disponibles para esta clave específica.
     */
    async function fetchAvailableModels(apiKeyToUse = null) {
        const apiKey = (apiKeyToUse || getApiKey()).trim();
        if (!apiKey) return [];

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;

        try {
            const res = await fetch(endpoint);
            if (!res.ok) {
                let errDetails = `HTTP ${res.status}`;
                try {
                    const j = await res.json();
                    if (j.error?.message) errDetails = j.error.message;
                } catch (_) {}
                const err = new Error(errDetails);
                err.status = res.status;
                throw err;
            }

            const data = await res.json();
            const list = data.models || [];

            // Filtrar solo modelos que soporten generación de contenido (generateContent)
            const available = list
                .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
                .map(m => {
                    const cleanId = m.name.replace(/^models\//, '');
                    return {
                        id: cleanId,
                        displayName: m.displayName || cleanId,
                        description: m.description || ''
                    };
                });

            if (available.length > 0) {
                discoveredModelsCache = available;
                try {
                    localStorage.setItem(STORAGE_AVAILABLE_MODELS, JSON.stringify(available));
                } catch (_) {}
            }

            return available;
        } catch (err) {
            console.warn('Fallo al consultar models.list de Gemini:', err);
            // Intentar recuperar de caché o devolver lista estándar vigente
            if (discoveredModelsCache && discoveredModelsCache.length > 0) {
                return discoveredModelsCache;
            }
            try {
                const cached = localStorage.getItem(STORAGE_AVAILABLE_MODELS);
                if (cached) {
                    discoveredModelsCache = JSON.parse(cached);
                    return discoveredModelsCache;
                }
            } catch (_) {}

            return [
                { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite' },
                { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
                { id: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash' }
            ];
        }
    }

    /**
     * Selecciona inteligentemente el mejor modelo disponible según velocidad,
     * precisión y vigencia oficial en la cuenta del usuario.
     */
    function pickBestModel(modelsList) {
        if (!Array.isArray(modelsList) || modelsList.length === 0) {
            return BASELINE_FALLBACK_MODEL;
        }

        const ids = modelsList.map(m => (typeof m === 'string' ? m : m.id));

        // Orden de preferencia: desde los más rápidos/novedosos hasta modelos estables
        const preferencePatterns = [
            /gemini-3\.5-flash-lite/i,
            /gemini-3\.\d+-flash/i,
            /gemini-2\.5-flash-lite/i,
            /gemini-2\.0-flash/i,
            /gemini-2\.0-flash-lite/i,
            /gemini-1\.5-flash/i,
            /gemini-.*flash/i,
            /gemini-1\.5-pro/i,
            /gemini-.*pro/i
        ];

        for (const pattern of preferencePatterns) {
            const match = ids.find(id => pattern.test(id));
            if (match) return match;
        }

        return ids[0];
    }

    /**
     * Resuelve el modelo exacto que se utilizará en la petición:
     * Si está configurado en 'auto' o el modelo elegido no existe en la cuenta,
     * auto-detecta el mejor modelo vigente mediante models.list.
     */
    async function resolveModelToUse(apiKey, preferredModel = null) {
        const choice = preferredModel || getSelectedModel();

        let available = [];
        try {
            available = await fetchAvailableModels(apiKey);
        } catch (_) {}

        if (choice && choice !== 'auto') {
            // Si el modelo pedido existe en la lista de la cuenta, usarlo
            if (available.length === 0 || available.some(m => m.id === choice)) {
                return choice;
            }
            console.warn(`El modelo configurado '${choice}' no está disponible en la cuenta. Seleccionando alternativa.`);
        }

        // Selección automática del mejor modelo
        if (available.length > 0) {
            return pickBestModel(available);
        }

        return BASELINE_FALLBACK_MODEL;
    }

    /**
     * Actualiza el selector de modelos de la interfaz de usuario con los modelos
     * reales detectados en la cuenta de Google Gemini.
     */
    function updateModelSelectorUI(modelsList = null, selectedId = null) {
        const selector = document.getElementById('geminiModelSelector');
        if (!selector) return;

        let models = modelsList;
        if (!models || models.length === 0) {
            models = discoveredModelsCache;
            if (!models) {
                try {
                    const cached = localStorage.getItem(STORAGE_AVAILABLE_MODELS);
                    if (cached) models = JSON.parse(cached);
                } catch (_) {}
            }
        }

        const currentChoice = selectedId || getSelectedModel();

        if (Array.isArray(models) && models.length > 0) {
            selector.innerHTML = '';

            // Opción por defecto: auto-detección
            const autoOpt = document.createElement('option');
            autoOpt.value = 'auto';
            autoOpt.textContent = '✨ Detección automática del mejor modelo (Recomendado)';
            if (currentChoice === 'auto') autoOpt.selected = true;
            selector.appendChild(autoOpt);

            models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = `${m.displayName || m.id} (${m.id})`;
                if (m.id === currentChoice) opt.selected = true;
                selector.appendChild(opt);
            });
        }
    }

    /**
     * Verifica la validez de una clave de API mediante detección de modelos
     * y una llamada mínima de confirmación.
     */
    async function testApiKey(keyToTest, model = null) {
        const apiKey = (keyToTest || getApiKey()).trim();
        if (!apiKey) {
            throw new Error('No se ha introducido ninguna clave de API.');
        }

        // 1. Detección automática de modelos vigentes para esta clave mediante models.list
        let availableModels = [];
        let modelListError = null;
        try {
            availableModels = await fetchAvailableModels(apiKey);
        } catch (err) {
            modelListError = err;
        }

        // Si models.list devolvió 400 o 403, la clave es inválida o carece de permisos
        if (modelListError && (modelListError.status === 400 || modelListError.status === 403)) {
            if (modelListError.status === 400) {
                throw new Error('Clave de API no válida o mal formada.');
            } else {
                throw new Error('Acceso denegado. Comprueba que tu clave API de Google Gemini esté activa.');
            }
        }

        // 2. Resolver el modelo adecuado para probar
        let targetModel = model;
        if (!targetModel || targetModel === 'auto') {
            targetModel = availableModels.length > 0 ? pickBestModel(availableModels) : BASELINE_FALLBACK_MODEL;
        } else if (availableModels.length > 0) {
            const exists = availableModels.some(m => m.id === targetModel);
            if (!exists) {
                targetModel = pickBestModel(availableModels);
            }
        }

        // 3. Probar llamada mínima de generación
        const start = performance.now();
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${encodeURIComponent(apiKey)}`;

        const payload = {
            contents: [
                {
                    role: 'user',
                    parts: [{ text: 'Responde estrictamente con la palabra: OK' }]
                }
            ]
        };

        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const elapsed = Math.round(performance.now() - start);

        if (!res.ok) {
            let errorMsg = `Error HTTP ${res.status}`;
            try {
                const errJson = await res.json();
                if (errJson?.error?.message) {
                    errorMsg = errJson.error.message;
                }
            } catch (_) {}

            if (res.status === 400) {
                throw new Error(`Clave de API inválida (${errorMsg})`);
            } else if (res.status === 403) {
                throw new Error(`Acceso denegado. Comprueba los permisos de la clave API (${errorMsg})`);
            } else if (res.status === 404) {
                // Si el modelo específico dio 404, reintentar con el baseline
                if (targetModel !== BASELINE_FALLBACK_MODEL) {
                    return await testApiKey(apiKey, BASELINE_FALLBACK_MODEL);
                }
                throw new Error(`El modelo '${targetModel}' no está disponible para esta clave.`);
            } else if (res.status === 429) {
                throw new Error('Límite de cuota excedido (Rate Limit). Espera unos minutos.');
            }
            throw new Error(`Fallo al verificar clave: ${errorMsg}`);
        }

        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // Actualizar el selector en la UI con los modelos descubiertos
        updateModelSelectorUI(availableModels, targetModel);

        return {
            success: true,
            latencyMs: elapsed,
            model: targetModel,
            availableCount: availableModels.length,
            response: text.trim()
        };
    }

    /**
     * Extrae y estructura las transacciones reales desde el estado de la aplicación
     * con pre-cálculo aritmético exacto (Ground Truth verificado).
     */
    function extractExpensesData(scope = 'all', categoryFilter = 'all') {
        let appData = {};
        let userConfig = {};

        if (window.getAppData && typeof window.getAppData === 'function') {
            const retrieved = window.getAppData();
            if (retrieved) {
                appData = retrieved.data || {};
                userConfig = retrieved.userConfig || {};
            }
        }

        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonthNum = now.getMonth() + 1;
        const currentMonthPrefix = `${currentYear}-${String(currentMonthNum).padStart(2, '0')}`;

        const prevMonthDate = new Date(currentYear, now.getMonth() - 1, 1);
        const prevMonthPrefix = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];

        const rawMovements = [];

        for (const catName in appData) {
            if (!Object.prototype.hasOwnProperty.call(appData, catName)) continue;
            if (categoryFilter !== 'all' && catName !== categoryFilter) continue;

            const catItems = appData[catName];
            if (Array.isArray(catItems)) {
                catItems.forEach(item => {
                    const rawAmt = Number(item.amount) || 0;
                    const isExpense = rawAmt < 0;
                    const absAmt = Math.abs(rawAmt);
                    const dateStr = item.date || '';

                    // Filtrado por alcance temporal
                    let keep = true;
                    if (scope === 'this_month') {
                        keep = dateStr.startsWith(currentMonthPrefix);
                    } else if (scope === 'last_month') {
                        keep = dateStr.startsWith(prevMonthPrefix);
                    } else if (scope === 'last_30_days') {
                        keep = dateStr >= thirtyDaysAgoStr;
                    } else if (scope === 'this_year') {
                        keep = dateStr.startsWith(String(currentYear));
                    }

                    if (keep) {
                        rawMovements.push({
                            id: item.id || '',
                            fecha: dateStr,
                            categoria: catName,
                            concepto: item.desc || '(Sin concepto)',
                            tipo: isExpense ? 'gasto' : 'ingreso',
                            importe_eur: Number(absAmt.toFixed(2)),
                            etiquetas: item.tags ? String(item.tags).trim() : '',
                            autor: item.created_by_email || ''
                        });
                    }
                });
            }
        }

        // Orden cronológico (antiguo -> reciente)
        rawMovements.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));

        // Totales aritméticos exactos verificados por código
        let sumGastos = 0;
        let sumIngresos = 0;
        const gastosPorCat = {};
        const gastosPorMes = {};
        const gastosPorTag = {};

        rawMovements.forEach(m => {
            if (m.tipo === 'gasto') {
                sumGastos += m.importe_eur;
                gastosPorCat[m.categoria] = (gastosPorCat[m.categoria] || 0) + m.importe_eur;

                const monthKey = m.fecha ? m.fecha.substring(0, 7) : 'Sin fecha';
                gastosPorMes[monthKey] = (gastosPorMes[monthKey] || 0) + m.importe_eur;

                if (m.etiquetas) {
                    m.etiquetas.split(',').forEach(tag => {
                        const cleanTag = tag.trim().toLowerCase();
                        if (cleanTag) {
                            gastosPorTag[cleanTag] = (gastosPorTag[cleanTag] || 0) + m.importe_eur;
                        }
                    });
                }
            } else {
                sumIngresos += m.importe_eur;
            }
        });

        // Top 5 gastos mayores
        const expensesOnly = rawMovements.filter(m => m.tipo === 'gasto');
        expensesOnly.sort((a, b) => b.importe_eur - a.importe_eur);
        const top5 = expensesOnly.slice(0, 5).map(m => ({
            fecha: m.fecha,
            categoria: m.categoria,
            concepto: m.concepto,
            importe_eur: m.importe_eur,
            etiquetas: m.etiquetas || undefined
        }));

        // Desglose con porcentajes exactos
        const desgloseCategorias = {};
        for (const cat in gastosPorCat) {
            const amt = gastosPorCat[cat];
            const pct = sumGastos > 0 ? ((amt / sumGastos) * 100).toFixed(2) : '0.00';
            desgloseCategorias[cat] = {
                total_gastado_eur: Number(amt.toFixed(2)),
                porcentaje_del_total_gastos: `${pct}%`
            };
        }

        const desgloseMeses = {};
        for (const mes in gastosPorMes) {
            desgloseMeses[mes] = Number(gastosPorMes[mes].toFixed(2));
        }

        const hourlyRate = Number(userConfig.hourlyRate) || 0;
        const horasVidaTotalGastos = hourlyRate > 0 ? (sumGastos / hourlyRate).toFixed(1) : null;

        return {
            metadata: {
                fecha_actual: now.toISOString().split('T')[0],
                filtro_alcance: scope,
                filtro_categoria: categoryFilter,
                total_movimientos_analizados: rawMovements.length,
                total_gastos_registrados: expensesOnly.length,
                salario_hora_configurado_eur: hourlyRate
            },
            totales_exactos_verificados: {
                total_gastos_eur: Number(sumGastos.toFixed(2)),
                total_ingresos_eur: Number(sumIngresos.toFixed(2)),
                balance_neto_eur: Number((sumIngresos - sumGastos).toFixed(2)),
                desglose_por_categoria: desgloseCategorias,
                gastos_por_mes: desgloseMeses,
                top_5_mayores_gastos: top5,
                horas_de_vida_equivalentes_gastos: horasVidaTotalGastos
            },
            transacciones_reales: rawMovements.map(m => ({
                fecha: m.fecha,
                tipo: m.tipo,
                categoria: m.categoria,
                concepto: m.concepto,
                importe_eur: m.importe_eur,
                etiquetas: m.etiquetas || undefined
            }))
        };
    }

    /**
     * Construye el Prompt del Sistema anti-alucinaciones estricto
     */
    function buildSystemInstruction() {
        return `Eres el Asistente Financiero Oficial e Inteligente de la aplicación FinanzasRoldan, impulsado por Google Gemini.
Tu misión es analizar con absoluta fidelidad y rigor matemático las transacciones reales del usuario y responder en español con explicaciones claras, amables y profesionales.

REGLAS ESTRICTAS DE EXACTITUD Y CERO ALUCINACIONES:
1. BASADO EXCLUSIVAMENTE EN DATOS REALES: Debes fundamentar todas tus afirmaciones, cálculos y desgloses ÚNICAMENTE en la lista de transacciones y resumen exacto suministrados en el mensaje.
2. NUNCA INVENTES DATOS: Queda terminantemente prohibido inventar o asumir gastos, ingresos, conceptos, fechas, categorías o importes que no figuren en los datos.
3. RIGOR MATEMÁTICO ABSOLUTO:
   - Utiliza siempre los totales pre-verificados suministrados como referencia de suma exacta.
   - Si realizas sumas, medias, restas, porcentajes, comparativas temporales o conteos, deben corresponder exactamente a los datos reales.
   - No redondees cifras a menos que el usuario lo pida expresamente. Muestra siempre los importes con 2 decimales y el símbolo € (ej: 42,50 €).
4. DISTINCIÓN ENTRE GASTOS E INGRESOS:
   - Tipo 'gasto': salidas de dinero.
   - Tipo 'ingreso': entradas de dinero.
   - El 'balance neto' es (ingresos - gastos).
5. AVISO CLARO CUANDO NO EXISTAN DATOS:
   - Si el usuario pregunta por un concepto, categoría o período para el cual NO existen registros en la lista (por ejemplo, "¿Cuánto gasté en cine?" y no hay nada de cine), indícalo explícitamente con claridad: "No consta ningún gasto registrado bajo el concepto o categoría 'cine' en los datos analizados."
   - Si la lista de transacciones está vacía, avisa de forma comprensiva que no hay movimientos disponibles en ese rango.
6. EQUIVALENCIA EN HORAS DE TRABAJO (HORAS DE VIDA):
   - Si el usuario pregunta cuántas horas de trabajo le costó un gasto o categoría y se ha configurado 'salario_hora_configurado_eur' > 0, calcula el tiempo exacto dividiendo el importe entre el precio por hora y exprésalo en horas y minutos. Si no está configurado, indícale que puede configurarlo en Ajustes.
7. FORMATO Y PRESENTACIÓN:
   - Responde de forma estructurada y legible.
   - Utiliza títulos y subtítulos en Markdown (###).
   - Usa negrita para destacar importes clave y fechas.
   - Si el usuario pide desgloses, tablas, comparativas o rankings, genera tablas Markdown bien alineadas:
     | Categoría | Importe (€) | % del Total |
   - Finaliza con una breve observación o conclusión constructiva basada en los números reales observados.`;
    }

    /**
     * Envía la consulta a la API oficial de Google Gemini
     */
    async function queryGemini(userQuestion, scope = 'all', categoryFilter = 'all') {
        const apiKey = getApiKey();
        if (!apiKey) {
            throw new Error('CONFIG_KEY_REQUIRED');
        }

        const dataContext = extractExpensesData(scope, categoryFilter);

        // Si no hay ninguna transacción en el contexto
        if (dataContext.metadata.total_movimientos_analizados === 0) {
            const scopeLabel = getScopeReadableName(scope);
            const catLabel = categoryFilter === 'all' ? 'todas las categorías' : `la categoría "${categoryFilter}"`;
            return `### ℹ️ Sin registros en este período\n\nNo se ha encontrado ninguna transacción registrada para **${scopeLabel}** en **${catLabel}**.\n\n*Prueba a seleccionar **"Todo el historial"** en el selector superior o añade nuevos movimientos en tus categorías para analizarlos.*`;
        }

        // Resolver dinámicamente el modelo vigente
        let targetModel = await resolveModelToUse(apiKey);
        const systemPrompt = buildSystemInstruction();

        const userMessagePayload = `[FECHA Y HORA ACTUAL]: ${dataContext.metadata.fecha_actual}
[ALCANCE DEL ANÁLISIS]: Período '${dataContext.metadata.filtro_alcance}', Categoría '${dataContext.metadata.filtro_categoria}'
[DATOS FINANCIEROS REALES VERIFICADOS]:
${JSON.stringify({
    resumen_verificado: dataContext.totales_exactos_verificados,
    total_transacciones: dataContext.metadata.total_movimientos_analizados,
    transacciones_detalladas: dataContext.transacciones_reales
}, null, 2)}

[PREGUNTA DEL USUARIO]:
${userQuestion}`;

        let response = null;

        try {
            response = await executeGeminiRequest(targetModel, apiKey, systemPrompt, userMessagePayload);
        } catch (err) {
            // Si el modelo devolvió 404, consultar models.list en vivo para buscar alternativa
            if (err.status === 404) {
                console.warn(`Modelo ${targetModel} devolvió 404. Consultando models.list para alternativa...`);
                try {
                    const liveModels = await fetchAvailableModels(apiKey);
                    const alternative = pickBestModel(liveModels.filter(m => m.id !== targetModel));
                    if (alternative && alternative !== targetModel) {
                        targetModel = alternative;
                        setSelectedModel(alternative);
                        response = await executeGeminiRequest(targetModel, apiKey, systemPrompt, userMessagePayload);
                    } else {
                        throw err;
                    }
                } catch (_) {
                    if (targetModel !== BASELINE_FALLBACK_MODEL) {
                        targetModel = BASELINE_FALLBACK_MODEL;
                        setSelectedModel(BASELINE_FALLBACK_MODEL);
                        response = await executeGeminiRequest(targetModel, apiKey, systemPrompt, userMessagePayload);
                    } else {
                        throw err;
                    }
                }
            } else {
                throw err;
            }
        }

        return response;
    }

    /**
     * Llamada REST a la API oficial de Gemini (v1beta)
     */
    async function executeGeminiRequest(model, apiKey, systemInstructionText, promptText) {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

        const requestBody = {
            contents: [
                {
                    role: 'user',
                    parts: [{ text: promptText }]
                }
            ],
            systemInstruction: {
                parts: [{ text: systemInstructionText }]
            },
            generationConfig: {
                temperature: 0.1, // Baja temperatura para máxima exactitud factual y matemática
                topP: 0.95
            }
        };

        let fetchResponse;
        try {
            fetchResponse = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });
        } catch (netErr) {
            const err = new Error('No se pudo conectar con la API de Google Gemini. Comprueba tu conexión a Internet o configuración de red.');
            err.code = 'NETWORK_ERROR';
            throw err;
        }

        if (!fetchResponse.ok) {
            let errorDetails = `Error HTTP ${fetchResponse.status}`;
            let errorCode = 'API_ERROR';
            try {
                const errData = await fetchResponse.json();
                if (errData && errData.error && errData.error.message) {
                    errorDetails = errData.error.message;
                    errorCode = errData.error.status || errorCode;
                }
            } catch (_) {}

            const errorObj = new Error(errorDetails);
            errorObj.status = fetchResponse.status;
            errorObj.code = errorCode;

            if (fetchResponse.status === 400) {
                errorObj.userMessage = 'Solicitud incorrecta o clave de API no válida. Por favor revisa la clave en Ajustes.';
            } else if (fetchResponse.status === 403) {
                errorObj.userMessage = 'Acceso denegado a la API de Gemini. Verifica que tu clave de API esté activa en Google AI Studio.';
            } else if (fetchResponse.status === 404) {
                errorObj.userMessage = `El modelo '${model}' no se encuentra disponible en tu cuenta.`;
            } else if (fetchResponse.status === 429) {
                errorObj.userMessage = 'Límite de cuota excedido (Rate Limit) en la API de Gemini. Espera unos momentos antes de realizar otra pregunta.';
            } else if (fetchResponse.status >= 500) {
                errorObj.userMessage = 'Los servidores de Google Gemini están experimentando problemas temporales. Inténtalo de nuevo en unos minutos.';
            } else {
                errorObj.userMessage = `Error de la API de Gemini: ${errorDetails}`;
            }

            throw errorObj;
        }

        const data = await fetchResponse.json();
        const candidate = data?.candidates?.[0];

        if (!candidate || !candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
            if (candidate?.finishReason === 'SAFETY') {
                throw new Error('La respuesta fue bloqueada por las políticas de seguridad de contenido.');
            }
            throw new Error('Gemini devolvió una respuesta vacía o no estructurada.');
        }

        return candidate.content.parts.map(p => p.text).join('\n');
    }

    /**
     * Parser Markdown ligero integrado con fallback
     */
    function renderMarkdownToHtml(markdownText) {
        if (!markdownText) return '';

        // Si marked.js está cargado desde CDN
        if (window.marked && typeof window.marked.parse === 'function') {
            try {
                return window.marked.parse(markdownText, { gfm: true, breaks: true });
            } catch (e) {
                console.warn('Error en marked.parse, usando parser de respaldo:', e);
            }
        }

        // Fallback nativo integrado
        let html = escapeHtml(markdownText);

        // Bloques de código
        html = html.replace(/```([a-z]*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Tablas Markdown
        html = html.replace(/((?:\|[^\n]+\|\r?\n)+)/g, function (tableBlock) {
            const rows = tableBlock.trim().split('\n').map(r => r.trim()).filter(Boolean);
            if (rows.length < 2) return tableBlock;

            let out = '<div style="overflow-x:auto;"><table class="gemini-table">';
            rows.forEach((row, idx) => {
                if (/^\|[\s\-:|]+\|$/.test(row)) return;

                const cells = row.split('|').slice(1, -1).map(c => c.trim());
                if (idx === 0) {
                    out += '<thead><tr>';
                    cells.forEach(c => { out += `<th>${c}</th>`; });
                    out += '</tr></thead><tbody>';
                } else {
                    out += '<tr>';
                    cells.forEach(c => { out += `<td>${c}</td>`; });
                    out += '</tr>';
                }
            });
            out += '</tbody></table></div>';
            return out;
        });

        // Títulos
        html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

        // Negrita y cursiva
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

        // Listas con viñetas
        html = html.replace(/^\s*[-*]\s+(.*)$/gim, '<li>$1</li>');
        html = html.replace(/(<li>[\s\S]*?<\/li>)/gim, '<ul>$1</ul>');
        html = html.replace(/<\/ul>\s*<ul>/gim, '');

        // Citas / Blockquotes
        html = html.replace(/^>\s+(.*)$/gim, '<blockquote>$1</blockquote>');

        // Saltos de línea
        html = html.replace(/\n\n+/g, '<br><br>');

        return html;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function getScopeReadableName(scope) {
        switch (scope) {
            case 'this_month': return 'Este mes en curso';
            case 'last_month': return 'El mes anterior';
            case 'last_30_days': return 'Los últimos 30 días';
            case 'this_year': return 'Este año';
            case 'all':
            default:
                return 'Todo el historial';
        }
    }

    // =========================================================
    // CONTROLADORES DE INTERFAZ DE USUARIO (UI CONTROLLER)
    // =========================================================

    /**
     * Se llama cuando el usuario abre la pestaña o modal de Gemini
     */
    async function onOpenView() {
        populateCategoriesSelector();
        updateContextStats();
        updateUiKeyStatus();

        const apiKey = getApiKey();
        const keyCard = document.getElementById('geminiInlineKeyCard');
        if (keyCard) {
            keyCard.style.display = apiKey ? 'none' : 'block';
        }

        // Auto-actualizar selector de modelos en segundo plano si hay clave
        if (apiKey) {
            fetchAvailableModels(apiKey).then(models => {
                updateModelSelectorUI(models);
            }).catch(() => {});
        }

        setTimeout(() => {
            const input = document.getElementById('geminiQuestionInput');
            if (input && apiKey) input.focus();
        }, 150);
    }

    /**
     * Rellena el selector de categorías del filtro de contexto
     */
    function populateCategoriesSelector() {
        const catSelect = document.getElementById('geminiScopeCategory');
        if (!catSelect) return;

        const currentVal = catSelect.value || 'all';
        catSelect.innerHTML = '<option value="all">Todas las categorías</option>';

        if (window.getAppData && typeof window.getAppData === 'function') {
            const app = window.getAppData();
            const dataObj = app?.data || {};
            const catNames = Object.keys(dataObj).sort();

            catNames.forEach(name => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                if (name === currentVal) opt.selected = true;
                catSelect.appendChild(opt);
            });
        }
    }

    /**
     * Actualiza el badge con el número de movimientos y gastos en el contexto actual
     */
    function updateContextStats() {
        const badge = document.getElementById('geminiContextBadge');
        if (!badge) return;

        const scope = document.getElementById('geminiScopePeriod')?.value || 'all';
        const cat = document.getElementById('geminiScopeCategory')?.value || 'all';

        const dataContext = extractExpensesData(scope, cat);
        const count = dataContext.metadata.total_movimientos_analizados;
        const totalGastos = dataContext.totales_exactos_verificados.total_gastos_eur;

        badge.innerHTML = `📊 <strong>${count}</strong> movimientos (${totalGastos.toFixed(2)}€ gastos)`;
    }

    /**
     * Actualiza los estados de la clave en la UI (pestaña y ajustes)
     */
    function updateUiKeyStatus() {
        const key = getApiKey();
        const hasKey = !!key;

        const statusBadge = document.getElementById('geminiKeyStatusBadge');
        if (statusBadge) {
            if (hasKey) {
                statusBadge.className = 'gemini-status-badge key-active';
                statusBadge.innerHTML = '● Clave activa';
                statusBadge.title = 'Clave API de Gemini configurada localmente';
            } else {
                statusBadge.className = 'gemini-status-badge key-missing';
                statusBadge.innerHTML = '⚠️ Sin Clave API';
                statusBadge.title = 'Configura tu clave para consultar a Gemini';
            }
        }

        const settingsInput = document.getElementById('geminiApiKeyInput');
        if (settingsInput && !settingsInput.value && hasKey) {
            settingsInput.value = key;
        }

        updateModelSelectorUI();
    }

    /**
     * Alterna la visibilidad de la tarjeta de configuración de API Key
     */
    function toggleInlineKeyCard() {
        const keyCard = document.getElementById('geminiInlineKeyCard');
        if (!keyCard) return;

        const isVisible = keyCard.style.display !== 'none';
        keyCard.style.display = isVisible ? 'none' : 'block';

        if (!isVisible) {
            const input = document.getElementById('geminiInlineKeyInput');
            if (input) {
                input.value = getApiKey();
                input.focus();
            }
        }
    }

    /**
     * Guarda la clave introducida en la tarjeta directa del chat
     */
    async function saveKeyFromInline() {
        const input = document.getElementById('geminiInlineKeyInput');
        const statusEl = document.getElementById('geminiInlineKeyStatus');
        if (!input) return;

        const val = input.value.trim();
        if (!val) {
            if (statusEl) {
                statusEl.innerHTML = '<span style="color:var(--red);">Por favor pega tu clave API de Gemini.</span>';
            }
            return;
        }

        if (statusEl) {
            statusEl.innerHTML = '<span style="color:var(--cyan);">Detectando modelos disponibles en tu cuenta...</span>';
        }

        try {
            const res = await testApiKey(val);
            await saveApiKey(val);
            if (statusEl) {
                statusEl.innerHTML = `<span style="color:var(--green);">✓ Clave verificada. Modelo asignado: <strong>${res.model}</strong> (${res.availableCount} modelos disponibles).</span>`;
            }
            setTimeout(() => {
                const keyCard = document.getElementById('geminiInlineKeyCard');
                if (keyCard) keyCard.style.display = 'none';
                if (statusEl) statusEl.innerHTML = '';
            }, 1600);
        } catch (err) {
            if (statusEl) {
                statusEl.innerHTML = `<span style="color:var(--red);">⚠️ ${escapeHtml(err.message)}</span>`;
            }
        }
    }

    /**
     * Guarda la clave desde la vista de Ajustes
     */
    async function saveKeyFromSettings() {
        const input = document.getElementById('geminiApiKeyInput');
        const modelSel = document.getElementById('geminiModelSelector');
        const statusEl = document.getElementById('geminiSettingsStatus');
        if (!input) return;

        const val = input.value.trim();
        if (modelSel) {
            setSelectedModel(modelSel.value);
        }

        if (!val) {
            if (statusEl) {
                statusEl.innerHTML = '<span style="color:var(--red);">Introduce una clave API válida antes de guardar.</span>';
            }
            return;
        }

        if (statusEl) {
            statusEl.innerHTML = '<span style="color:var(--cyan);">Consultando modelos vigentes en tu cuenta...</span>';
        }

        try {
            const res = await testApiKey(val, modelSel ? modelSel.value : null);
            await saveApiKey(val);
            if (statusEl) {
                statusEl.innerHTML = `<span style="color:var(--green);">✓ Conexión exitosa (${res.latencyMs}ms). Modelo en uso: <strong>${res.model}</strong> (${res.availableCount} modelos detectados en tu cuenta).</span>`;
            }
        } catch (err) {
            if (statusEl) {
                statusEl.innerHTML = `<span style="color:var(--red);">⚠️ Error al verificar: ${escapeHtml(err.message)}</span>`;
            }
        }
    }

    /**
     * Prueba la clave desde la vista de Ajustes
     */
    async function testApiKeyFromSettings() {
        const input = document.getElementById('geminiApiKeyInput');
        const modelSel = document.getElementById('geminiModelSelector');
        const statusEl = document.getElementById('geminiSettingsStatus');

        const val = input ? input.value.trim() : getApiKey();
        const model = modelSel ? modelSel.value : getSelectedModel();

        if (!val) {
            if (statusEl) {
                statusEl.innerHTML = '<span style="color:var(--orange);">⚠️ Pega o introduce primero una clave de API para probarla.</span>';
            }
            return;
        }

        if (statusEl) {
            statusEl.innerHTML = '<span style="color:var(--cyan);">Verificando modelos disponibles en Google Gemini...</span>';
        }

        try {
            const res = await testApiKey(val, model);
            if (statusEl) {
                statusEl.innerHTML = `<span style="color:var(--green);">✓ Conexión exitosa con <strong>${res.model}</strong> en ${res.latencyMs}ms (${res.availableCount} modelos activos en tu cuenta). Respuesta: "${escapeHtml(res.response)}".</span>`;
            }
        } catch (err) {
            if (statusEl) {
                statusEl.innerHTML = `<span style="color:var(--red);">⚠️ Error de conexión: ${escapeHtml(err.message)}</span>`;
            }
        }
    }

    /**
     * Borra la clave desde la vista de Ajustes
     */
    async function removeKeyFromSettings() {
        if (!confirm('¿Deseas eliminar la clave API de Gemini configurada?')) return;

        await removeApiKey();
        const input = document.getElementById('geminiApiKeyInput');
        if (input) input.value = '';

        const statusEl = document.getElementById('geminiSettingsStatus');
        if (statusEl) {
            statusEl.innerHTML = '<span style="color:var(--orange);">Clave eliminada.</span>';
        }
    }

    /**
     * Ejecuta una sugerencia de pregunta predefinida
     */
    function askSuggestion(questionText) {
        const input = document.getElementById('geminiQuestionInput');
        if (input) {
            input.value = questionText;
        }
        submitQuery();
    }

    /**
     * Envía la pregunta escrita por el usuario
     */
    async function submitQuery() {
        if (isRequestInProgress) return;

        const input = document.getElementById('geminiQuestionInput');
        if (!input) return;

        const question = input.value.trim();
        if (!question) {
            input.focus();
            return;
        }

        const apiKey = getApiKey();
        if (!apiKey) {
            toggleInlineKeyCard();
            const statusEl = document.getElementById('geminiInlineKeyStatus');
            if (statusEl) {
                statusEl.innerHTML = '<span style="color:var(--orange);">⚠️ Introduce tu clave API de Google Gemini para realizar consultas.</span>';
            }
            return;
        }

        const scope = document.getElementById('geminiScopePeriod')?.value || 'all';
        const category = document.getElementById('geminiScopeCategory')?.value || 'all';

        // 1. Añadir mensaje del usuario a la conversación
        appendMessage('user', question);
        input.value = '';
        input.style.height = 'auto';

        // 2. Mostrar indicador de carga
        showLoading(true);
        isRequestInProgress = true;
        const sendBtn = document.getElementById('geminiSendBtn');
        if (sendBtn) sendBtn.disabled = true;

        try {
            // 3. Ejecutar consulta
            const replyMarkdown = await queryGemini(question, scope, category);

            // 4. Añadir respuesta de Gemini
            appendMessage('gemini', replyMarkdown, {
                scope: scope,
                category: category,
                timestamp: new Date()
            });

        } catch (err) {
            console.error('Error al consultar Gemini:', err);
            let displayError = err.userMessage || err.message || 'Error inesperado al consultar Gemini.';

            if (err.message === 'CONFIG_KEY_REQUIRED') {
                displayError = 'No se ha configurado ninguna clave API de Gemini. Configúrala arriba o en Ajustes.';
                toggleInlineKeyCard();
            }

            appendMessage('gemini', `### ⚠️ No se pudo completar la consulta\n\n${displayError}\n\n*Si el problema persiste, verifica tu conexión o el estado de tu clave en Google AI Studio.*`, { isError: true });
        } finally {
            showLoading(false);
            isRequestInProgress = false;
            if (sendBtn) sendBtn.disabled = false;
        }
    }

    /**
     * Renderiza un mensaje en el contenedor del chat
     */
    function appendMessage(sender, text, meta = {}) {
        const chatContainer = document.getElementById('geminiChatMessages');
        if (!chatContainer) return;

        const msgDiv = document.createElement('div');
        msgDiv.className = `gemini-msg gemini-msg-${sender}`;

        const isUser = sender === 'user';
        const avatar = isUser ? '👤' : '✨';
        const name = isUser ? 'Tú' : 'Gemini Financiero';
        const timeStr = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(new Date());

        const htmlContent = isUser ? escapeHtml(text).replace(/\n/g, '<br>') : renderMarkdownToHtml(text);

        let copyButtonHtml = '';
        if (!isUser) {
            copyButtonHtml = `
                <button class="btn-gemini-action" onclick="GeminiAssistant.copyResponse(this)" data-content="${encodeURIComponent(text)}" title="Copiar respuesta">
                    📋 Copiar
                </button>
            `;
        }

        let scopeInfoHtml = '';
        if (meta && meta.scope) {
            const scopeName = getScopeReadableName(meta.scope);
            const catName = meta.category === 'all' ? 'Todas' : meta.category;
            scopeInfoHtml = `<span style="font-size:0.68rem; color:var(--text-dark);">Contexto: ${scopeName} (${catName})</span>`;
        }

        msgDiv.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <div style="display:flex; align-items:center; gap:6px;">
                    <span style="font-size:1.1rem;">${avatar}</span>
                    <strong style="font-size:0.82rem; color:${isUser ? 'var(--cyan)' : 'var(--purple)'};">${name}</strong>
                </div>
                <span style="font-size:0.7rem; color:var(--text-dark);">${timeStr}</span>
            </div>
            <div class="gemini-msg-content">
                ${htmlContent}
            </div>
            ${!isUser ? `
            <div class="gemini-msg-footer">
                ${scopeInfoHtml}
                <div>${copyButtonHtml}</div>
            </div>` : ''}
        `;

        chatContainer.appendChild(msgDiv);

        // Auto-scroll al nuevo mensaje
        msgDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        // Guardar en memoria de sesión
        chatHistory.push({ sender, text, meta, time: timeStr });
    }

    /**
     * Muestra u oculta el indicador de carga
     */
    function showLoading(show) {
        const loader = document.getElementById('geminiLoadingIndicator');
        if (loader) {
            loader.style.display = show ? 'flex' : 'none';
            if (show) {
                loader.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    }

    /**
     * Copia el contenido de una respuesta al portapapeles
     */
    async function copyResponse(btnElement) {
        if (!btnElement) return;
        const encoded = btnElement.getAttribute('data-content');
        if (!encoded) return;

        try {
            const textToCopy = decodeURIComponent(encoded);
            await navigator.clipboard.writeText(textToCopy);
            const originalText = btnElement.innerHTML;
            btnElement.innerHTML = '✓ ¡Copiado!';
            btnElement.style.color = 'var(--green)';
            setTimeout(() => {
                btnElement.innerHTML = originalText;
                btnElement.style.color = '';
            }, 1800);
        } catch (err) {
            console.error('Error al copiar al portapapeles:', err);
        }
    }

    /**
     * Limpia la conversación actual
     */
    function clearChat() {
        const chatContainer = document.getElementById('geminiChatMessages');
        if (!chatContainer) return;

        chatHistory = [];
        chatContainer.innerHTML = '';
        renderWelcomeMessage();
    }

    /**
     * Renderiza el mensaje de bienvenida y estado inicial
     */
    function renderWelcomeMessage() {
        const chatContainer = document.getElementById('geminiChatMessages');
        if (!chatContainer) return;

        const welcomeDiv = document.createElement('div');
        welcomeDiv.className = 'gemini-welcome-card';
        welcomeDiv.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
                <div style="background:rgba(168,85,247,0.2); width:42px; height:42px; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:1.4rem; border:1px solid rgba(168,85,247,0.3);">
                    ✨
                </div>
                <div>
                    <h4 style="margin:0; font-size:1rem; color:#ffffff; font-weight:800;">Consultas Financieras con Gemini</h4>
                    <p style="margin:2px 0 0 0; font-size:0.75rem; color:var(--text-muted);">
                        Cálculos exactos basados estrictamente en tus datos reales, sin alucinaciones.
                    </p>
                </div>
            </div>
            <div style="font-size:0.8rem; color:var(--text); line-height:1.5; margin-bottom:12px;">
                Puedes preguntarme en lenguaje natural sobre:
                <ul style="margin:6px 0 6px 18px; color:var(--text-muted); font-size:0.78rem;">
                    <li><strong>Totales y medias:</strong> <em>"¿Cuánto he gastado este mes en Supermercado?"</em></li>
                    <li><strong>Desgloses y tablas:</strong> <em>"Muéstrame una tabla con el porcentaje de gasto por categoría."</em></li>
                    <li><strong>Récords y mayores gastos:</strong> <em>"¿Cuál ha sido mi compra más cara y cuándo fue?"</em></li>
                    <li><strong>Equivalencia en tiempo:</strong> <em>"¿Cuántas horas de trabajo representan mis gastos de ocio?"</em></li>
                </ul>
            </div>
            <div style="font-size:0.72rem; color:var(--cyan); font-weight:700;">
                💡 Selecciona el período arriba o usa una de las píldoras de consulta rápida para empezar:
            </div>
        `;
        chatContainer.appendChild(welcomeDiv);
    }

    /**
     * Alterna la visibilidad de la contraseña/clave en un input
     */
    function toggleKeyVisibility(inputId, btn) {
        const input = document.getElementById(inputId);
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        if (btn) {
            btn.textContent = isPassword ? '🔒' : '👁️';
        }
    }

    // Inicializar listeners y eventos cuando el DOM esté listo
    document.addEventListener('DOMContentLoaded', () => {
        renderWelcomeMessage();
        updateUiKeyStatus();

        // Control de enter en el textarea de pregunta
        const questionInput = document.getElementById('geminiQuestionInput');
        if (questionInput) {
            questionInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submitQuery();
                }
            });

            // Auto-expandir altura según texto
            questionInput.addEventListener('input', function () {
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            });
        }
    });

    // Exponer API pública en window.GeminiAssistant
    window.GeminiAssistant = {
        getApiKey,
        saveApiKey,
        removeApiKey,
        getSelectedModel,
        setSelectedModel,
        fetchAvailableModels,
        testApiKey,
        extractExpensesData,
        queryGemini,
        onOpenView,
        populateCategoriesSelector,
        updateContextStats,
        updateUiKeyStatus,
        updateModelSelectorUI,
        toggleInlineKeyCard,
        saveKeyFromInline,
        saveKeyFromSettings,
        testApiKeyFromSettings,
        removeKeyFromSettings,
        askSuggestion,
        submitQuery,
        copyResponse,
        clearChat,
        toggleKeyVisibility
    };

})(window);
