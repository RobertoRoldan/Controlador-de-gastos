# 🤖 Integración de Google Gemini IA - FinanzasRoldan

Esta aplicación cuenta con un asistente financiero inteligente integrado con la **API oficial de Google Gemini** para responder consultas en lenguaje natural basadas **estrictamente en tus datos y gastos reales**, con precisión matemática y **sin alucinaciones**.

---

## 🚀 1. Cómo Obtener tu Clave API de Google Gemini (Gratis)

Google ofrece acceso gratuito a su API de Gemini a través de **Google AI Studio**:

1. Entra en [Google AI Studio (API Keys)](https://aistudio.google.com/app/apikey).
2. Inicia sesión con tu cuenta de Google.
3. Haz clic en **"Create API Key"** (Crear clave de API).
4. Selecciona un proyecto nuevo o existente de Google Cloud.
5. Copia la clave generada (empieza por `AIzaSy...`).

---

## ⚙️ 2. Cómo Configurar la Clave en la Aplicación

Tienes dos formas directas e intuitivas de configurarla:

### Opción A: Desde la Pestaña "AJUSTES"
1. Abre la aplicación y haz clic en la pestaña **AJUSTES** en la barra inferior.
2. Despliega la sección **✨ Google Gemini API (Consultas Inteligentes)**.
3. Pega tu clave en el campo `CLAVE API DE GOOGLE GEMINI`.
4. Selecciona el modelo deseado (recomendado: `✨ Detección automática del mejor modelo` o `Gemini 3.5 Flash-Lite`).
5. Pulsa **⚡ PROBAR CONEXIÓN** para verificar que funciona en tiempo real.
6. Pulsa **💾 GUARDAR CONFIGURACIÓN**.

### Opción B: Directamente desde el Panel de Gemini IA
1. Haz clic en la pestaña **✨ GEMINI IA** (o en el botón `✨ IA` de la barra superior o en el botón flotante `+`).
2. Si aún no tienes clave, pulsa el botón **🔑 Clave API** en la cabecera.
3. Pega tu clave y pulsa **💾 VERIFICAR Y GUARDAR**.

---

## 🔒 3. Seguridad y Repositorio de GitHub

Esta integración ha sido diseñada cumpliendo las mejores prácticas de seguridad para repositorios públicos y privados en GitHub:

- **Sin claves en el código:** Ninguna clave de API está escrita en el código fuente (`index.html`, `gemini.js`, `sw.js`).
- **Almacenamiento local del usuario:** La clave se guarda exclusivamente en el navegador del usuario (`localStorage`).
- **Sincronización multiusuario segura:** Si estás autenticado en Supabase, la clave se sincroniza en tu registro privado (`user_config`) protegido por **Row Level Security (RLS)**, de modo que solo tú puedes leer o escribir tu propia configuración.
- **Protección Git:** Se incluye un archivo `.gitignore` para impedir que archivos locales de entorno (`.env`, `*.key`, etc.) se suban accidentalmente a GitHub.

---

## 📊 4. Cómo Funciona: Datos Exactos sin Alucinaciones

A diferencia de un chat genérico, esta integración garantiza **cero alucinaciones**:

1. **Extracción y filtrado en tiempo real:** La app extrae los registros reales de gastos e ingresos directamente del estado en memoria (`data`) según el período (ej: *Este mes*, *Últimos 30 días*, *Este año* o *Todo el historial*) y categoría seleccionada.
2. **Pre-cálculo aritmético (Ground Truth):** El código calcula y valida previamente los totales exactos (total gastos, total ingresos, balance neto, suma por categoría, gastos por mes y mayores gastos) y los envía a Gemini.
3. **Instrucción de sistema estricta:** Gemini opera bajo un prompt de sistema con directrices estrictas:
   - Prohibido inventar transacciones, fechas o cifras.
   - Cálculos exactos sin redondeos no solicitados y formateados en euros (`XX,XX €`).
   - Si se consulta por un concepto o rango sobre el que no hay datos, **avisa explícitamente de que no consta en los registros**.
   - Si tienes configurado tu **Salario Hora** en Ajustes, calcula con precisión el tiempo de vida equivalente a cualquier gasto.

---

## 💬 5. Ejemplos de Consultas que Puedes Hacerle

- *"¿Cuánto he gastado este mes y en qué categorías?"*
- *"Muéstrame una tabla detallada con mis gastos por categoría y su porcentaje del total."*
- *"¿Cuál ha sido mi compra más cara y en qué fecha ocurrió?"*
- *"¿Cuánto he gastado en Mercadona o compras de comida en lo que va de año?"*
- *"Compara mis gastos entre el mes pasado y este mes."*
- *"¿Cuántas horas de trabajo representa lo que he gastado en ocio según mi salario hora?"*
- *"¿Cuáles han sido mis 5 mayores gastos registrados?"*
