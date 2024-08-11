// ASAASNotionIntegration

import dotenv from "dotenv";
import fetch from "node-fetch";
import { Client } from "@notionhq/client";
import winston from "winston";
import cron from "node-cron";
import { v4 as uuidv4 } from "uuid";
import { performance } from "perf_hooks";
import crypto from "crypto";
import AsyncLock from "async-lock";
import PQueue from "p-queue";

dotenv.config();

const ASAAS_API_URL = "https://www.asaas.com/api/v3";
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const notion = new Client({ auth: NOTION_API_KEY });
const lock = new AsyncLock();

// Configuração do logger
const logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json(),
    ),
    defaultMeta: { service: "asaas-notion-sync" },
    transports: [
        new winston.transports.File({ filename: "error.log", level: "error" }),
        new winston.transports.File({ filename: "combined.log" }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple(),
            ),
        }),
    ],
});

// Cache para armazenar dados temporariamente
const cache = new Map();

// Função para gerar hash MD5
const generateMD5Hash = (data) => {
    return crypto.createHash("md5").update(JSON.stringify(data)).digest("hex");
};

// Função para formatar nomes próprios corretamente
function formatProperName(name) {
    const lowercaseWords = ["de", "da", "do", "dos", "das", "e"];
    return name
        .split(" ")
        .map((word, index) => {
            if (index === 0 || !lowercaseWords.includes(word.toLowerCase())) {
                return (
                    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
                );
            }
            return word.toLowerCase();
        })
        .join(" ");
}

// Função para formatar texto em Sentence case
function toSentenceCase(str) {
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// Função para formatar número de telefone brasileiro
function formatBrazilianPhoneNumber(phoneNumber) {
    const numbers = phoneNumber.replace(/\D/g, "");
    if (numbers.length < 10 || numbers.length > 11) {
        return phoneNumber;
    }
    const ddd = numbers.substring(0, 2);
    const mainNumber =
        numbers.length === 11
            ? `${numbers.substring(2, 7)}-${numbers.substring(7)}`
            : `${numbers.substring(2, 6)}-${numbers.substring(6)}`;
    return `+55 (${ddd}) ${mainNumber}`;
}

// Função para processar a descrição do produto
function processProductDescription(description) {
    const parcelaMatch = description.match(/Parcela (\d+) De (\d+)/i);
    const productNameMatch = description.match(
        /\. (.+?) - (Anual|Semestral|Mensal)/i,
    );

    let pagamento = "";
    let produto = "";

    if (parcelaMatch) {
        pagamento = `Parcela ${parcelaMatch[1]} de ${parcelaMatch[2]}`;
    }

    if (productNameMatch) {
        produto = `${productNameMatch[1]} - ${productNameMatch[2]}`;
    }

    // Verifica se o produto é válido (não contém a palavra "teste")
    const isValidProduct = !produto.toLowerCase().includes("teste");

    return {
        pagamento: toSentenceCase(pagamento),
        produto: formatProperName(produto),
        isValidProduct,
    };
}

// Função para buscar dados da API ASAAS com limite de taxa adaptativo e tentativas exponenciais
async function fetchAsaasData(endpoint, params = {}) {
    const url = new URL(`${ASAAS_API_URL}/${endpoint}`);
    Object.keys(params).forEach((key) =>
        url.searchParams.append(key, params[key]),
    );

    const options = {
        method: "GET",
        headers: {
            access_token: ASAAS_API_KEY,
            "Content-Type": "application/json",
        },
    };

    const maxRetries = 5;
    let retries = 0;
    let delay = 1000;

    while (retries < maxRetries) {
        try {
            const response = await fetch(url, options);

            if (response.status === 429) {
                const retryAfter = parseInt(
                    response.headers.get("Retry-After") || "5",
                    10,
                );
                logger.warn(
                    `Limite de taxa atingido. Tentando novamente após ${retryAfter} segundos.`,
                );
                await new Promise((resolve) =>
                    setTimeout(resolve, retryAfter * 1000),
                );
                retries++;
                delay *= 2;
                continue;
            }

            if (!response.ok) {
                throw new Error(`Erro HTTP! status: ${response.status}`);
            }

            const data = await response.json();
            return data;
        } catch (error) {
            logger.error(`Erro ao buscar dados do ASAAS (${endpoint}):`, error);
            retries++;
            if (retries === maxRetries) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
}

// Função para buscar todos os dados de endpoints paginados do ASAAS com cache
async function fetchAllAsaasData(endpoint) {
    const cacheKey = `asaas_${endpoint}`;
    const cachedData = cache.get(cacheKey);

    if (cachedData) {
        const { data, timestamp } = cachedData;
        if (Date.now() - timestamp < 3600000) {
            return data;
        }
    }

    let allData = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
        const data = await fetchAsaasData(endpoint, { limit, offset });
        allData = allData.concat(data.data);
        hasMore = data.hasMore;
        offset += limit;
    }

    cache.set(cacheKey, { data: allData, timestamp: Date.now() });
    return allData;
}

// Função para buscar pagamentos e clientes do ASAAS com paralelização
async function fetchAsaasPaymentsAndCustomers() {
    logger.info("Buscando pagamentos e clientes do ASAAS...");
    const startTime = performance.now();

    const [payments, customers] = await Promise.all([
        fetchAllAsaasData("payments"),
        fetchAllAsaasData("customers"),
    ]);

    const endTime = performance.now();
    logger.info(`Busca concluída em ${(endTime - startTime).toFixed(2)}ms`);

    return { payments, customers };
}

// Função para combinar dados de pagamento e cliente com otimização de desempenho
function combinePaymentAndCustomerData(payments, customers) {
    logger.info("Combinando dados de pagamento e cliente...");
    const startTime = performance.now();

    const customerMap = new Map(
        customers.map((customer) => [customer.id, customer]),
    );

    const combinedData = payments.map((payment) => {
        const customer = customerMap.get(payment.customer);
        return {
            id: payment.id,
            description: payment.description,
            status: payment.status,
            dateCreated: payment.dateCreated,
            value: payment.value,
            billingType: payment.billingType,
            customerName: customer ? customer.name : "",
            customerEmail: customer ? customer.email : "",
            customerMobilePhone: customer ? customer.mobilePhone : "",
            customerState: customer ? customer.state : "",
        };
    });

    const endTime = performance.now();
    logger.info(
        `Combinação concluída em ${(endTime - startTime).toFixed(2)}ms`,
    );

    return combinedData;
}

// Função para traduzir e colorir o status do pagamento
function translateAndColorPaymentStatus(status) {
    switch (status) {
        case "CONFIRMED":
            return { name: "Confirmado", color: "blue" };
        case "OVERDUE":
            return { name: "Vencido", color: "red" };
        case "RECEIVED":
            return { name: "Recebido", color: "green" };
        default:
            return { name: status, color: "default" };
    }
}

// Função para traduzir e colorir a forma de pagamento
function translateAndColorPaymentMethod(method) {
    switch (method) {
        case "CREDIT_CARD":
            return { name: "Cartão de Crédito", color: "blue" };
        case "PIX":
            return { name: "Pix", color: "green" };
        case "BOLETO":
            return { name: "Boleto", color: "orange" };
        default:
            return { name: method, color: "default" };
    }
}

// Função para validar e sanitizar dados antes de sincronizar com o Notion
function validateAndSanitizeData(item) {
    const sanitizedItem = { ...item };

    const { pagamento, produto, isValidProduct } = processProductDescription(
        item.description || "Sem descrição",
    );

    sanitizedItem.pagamento = pagamento;
    sanitizedItem.produto = produto;
    sanitizedItem.isValidProduct = isValidProduct;

    const date = new Date(item.dateCreated);
    sanitizedItem.dateCreated = !isNaN(date.getTime())
        ? date.toISOString().split("T")[0].toLowerCase()
        : null;

    sanitizedItem.value = typeof item.value === "number" ? item.value : 0;

    const maxLength = 2000;
    const truncateString = (str) =>
        str && typeof str === "string" ? str.substring(0, maxLength) : "";

    sanitizedItem.customerName = formatProperName(
        truncateString(item.customerName),
    );
    sanitizedItem.customerState = truncateString(item.customerState);

    sanitizedItem.id = String(item.id || "");
    sanitizedItem.status = translateAndColorPaymentStatus(item.status);
    sanitizedItem.billingType = translateAndColorPaymentMethod(
        item.billingType,
    );
    sanitizedItem.customerEmail = String(
        item.customerEmail || "",
    ).toLowerCase();
    sanitizedItem.customerMobilePhone = formatBrazilianPhoneNumber(
        String(item.customerMobilePhone || ""),
    );

    return sanitizedItem;
}

// Função para buscar esquema do banco de dados do Notion com retry
async function fetchNotionDatabaseSchema() {
    const maxRetries = 3;
    let retries = 0;

    while (retries < maxRetries) {
        try {
            const response = await notion.databases.retrieve({
                database_id: NOTION_DATABASE_ID,
            });
            return response.properties;
        } catch (error) {
            logger.error(
                "Erro ao buscar esquema do banco de dados do Notion:",
                error,
            );
            retries++;
            if (retries === maxRetries) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
        }
    }
}

// Função para verificar e atualizar propriedades do banco de dados do Notion
async function updateNotionDatabaseSchema() {
    logger.info(
        "Verificando e atualizando propriedades do banco de dados do Notion...",
    );
    const requiredProperties = {
        ID: { rich_text: {} },
        Produto: { title: {} },
        Pagamento: { rich_text: {} },
        "Status da compra": {
            select: {
                options: [
                    { name: "Confirmado", color: "blue" },
                    { name: "Vencido", color: "red" },
                    { name: "Recebido", color: "green" },
                ],
            },
        },
        "Data da compra": { date: {} },
        Preço: { number: {} },
        "Forma de pagamento": {
            select: {
                options: [
                    { name: "Cartão de Crédito", color: "blue" },
                    { name: "Pix", color: "green" },
                    { name: "Boleto", color: "orange" },
                ],
            },
        },
        Aluno: { rich_text: {} },
        Email: { email: {} },
        "WhatsApp / Telegram": { phone_number: {} },
        Estado: { rich_text: {} },
    };

    const currentSchema = await fetchNotionDatabaseSchema();
    const propertiesToAdd = {};

    for (const [propName, propConfig] of Object.entries(requiredProperties)) {
        if (!currentSchema[propName]) {
            propertiesToAdd[propName] = propConfig;
        }
    }

    if (Object.keys(propertiesToAdd).length > 0) {
        try {
            await notion.databases.update({
                database_id: NOTION_DATABASE_ID,
                properties: propertiesToAdd,
            });
            logger.info(
                "Propriedades do banco de dados do Notion atualizadas com sucesso.",
            );
        } catch (error) {
            logger.error(
                "Erro ao atualizar propriedades do banco de dados do Notion:",
                error,
            );
            throw error;
        }
    } else {
        logger.info(
            "Nenhuma atualização necessária para as propriedades do banco de dados do Notion.",
        );
    }
}

// Função para verificar se um registro já existe no Notion com cache
const checkExistingRecordCache = new Map();

async function checkExistingRecord(id) {
    if (checkExistingRecordCache.has(id)) {
        return checkExistingRecordCache.get(id);
    }

    const response = await notion.databases.query({
        database_id: NOTION_DATABASE_ID,
        filter: {
            property: "ID",
            rich_text: {
                equals: id,
            },
        },
        page_size: 1,
    });

    const result = response.results[0] ? response.results[0].id : null;
    checkExistingRecordCache.set(id, result);
    return result;
}

// Função para gerar um atraso aleatório (jitter)
function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}

// Função para retry com backoff exponencial e jitter
async function retryOperation(operation, maxRetries = 5, initialDelay = 1000) {
    let retries = 0;
    while (retries < maxRetries) {
        try {
            return await operation();
        } catch (error) {
            if (error.code === "conflict_error" && retries < maxRetries - 1) {
                retries++;
                const delay =
                    initialDelay * Math.pow(2, retries) +
                    getRandomDelay(0, 1000);
                logger.warn(
                    `Conflito detectado. Tentando novamente em ${delay}ms. Tentativa ${retries} de ${maxRetries}. Erro: ${error.message}`,
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
    throw new Error(`Operação falhou após ${maxRetries} tentativas`);
}

// Função otimizada syncToNotion
async function syncToNotion(data) {
    logger.info(
        `Iniciando sincronização com o Notion para ${data.length} itens...`,
    );
    const batchSize = 5;
    const batches = Math.ceil(data.length / batchSize);

    await updateNotionDatabaseSchema();

    const queue = new PQueue({ concurrency: 1 });

    for (let i = 0; i < batches; i++) {
        const batch = data.slice(i * batchSize, (i + 1) * batchSize);
        await queue.add(async () => {
            try {
                await Promise.all(
                    batch.map(async (item) => {
                        const sanitizedItem = validateAndSanitizeData(item);

                        // Pula itens com produtos inválidos
                        if (!sanitizedItem.isValidProduct) {
                            logger.info(
                                `Pulando item inválido: ${sanitizedItem.id}`,
                            );
                            return;
                        }

                        const properties = {
                            ID: {
                                rich_text: [
                                    { text: { content: sanitizedItem.id } },
                                ],
                            },
                            Produto: {
                                title: [
                                    {
                                        text: {
                                            content: sanitizedItem.produto,
                                        },
                                    },
                                ],
                            },
                            Pagamento: {
                                rich_text: [
                                    {
                                        text: {
                                            content: sanitizedItem.pagamento,
                                        },
                                    },
                                ],
                            },
                            "Status da compra": {
                                select: sanitizedItem.status,
                            },
                            "Data da compra": {
                                date: { start: sanitizedItem.dateCreated },
                            },
                            Preço: { number: sanitizedItem.value },
                            "Forma de pagamento": {
                                select: sanitizedItem.billingType,
                            },
                            Aluno: {
                                rich_text: [
                                    {
                                        text: {
                                            content: sanitizedItem.customerName,
                                        },
                                    },
                                ],
                            },
                            Email: { email: sanitizedItem.customerEmail },
                            "WhatsApp / Telegram": {
                                phone_number: sanitizedItem.customerMobilePhone,
                            },
                            Estado: {
                                rich_text: [
                                    {
                                        text: {
                                            content:
                                                sanitizedItem.customerState,
                                        },
                                    },
                                ],
                            },
                        };

                        await retryOperation(async () => {
                            const existingPageId = await checkExistingRecord(
                                sanitizedItem.id,
                            );

                            if (existingPageId) {
                                await notion.pages.update({
                                    page_id: existingPageId,
                                    properties: properties,
                                });
                            } else {
                                await notion.pages.create({
                                    parent: { database_id: NOTION_DATABASE_ID },
                                    properties: properties,
                                });
                            }
                        });

                        // Adiciona um pequeno atraso entre as operações
                        await new Promise((resolve) =>
                            setTimeout(resolve, 200),
                        );
                    }),
                );
                logger.info(
                    `Lote ${i + 1}/${batches} sincronizado com sucesso.`,
                );
            } catch (error) {
                logger.error(
                    `Erro ao sincronizar lote ${i + 1}/${batches}:`,
                    error,
                );
            }
        });

        // Adiciona um atraso entre os lotes
        if (i < batches - 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }

    await queue.onIdle();
}

// Função principal para orquestrar o processo de sincronização
async function syncAsaasToNotion() {
    const syncId = uuidv4();
    logger.info(`Iniciando processo de sincronização (ID: ${syncId})`);

    try {
        const startTime = performance.now();

        const { payments, customers } = await fetchAsaasPaymentsAndCustomers();
        const combinedData = combinePaymentAndCustomerData(payments, customers);

        logger.info(`Buscados ${combinedData.length} registros do ASAAS`);

        await syncToNotion(combinedData);

        const endTime = performance.now();
        const duration = (endTime - startTime) / 1000;

        logger.info(
            `Processo de sincronização concluído com sucesso (ID: ${syncId}). Tempo total: ${duration.toFixed(2)} segundos`,
        );
        console.log("Sincronização concluída com sucesso!");
    } catch (error) {
        logger.error(
            `Falha no processo de sincronização (ID: ${syncId}):`,
            error,
        );
        console.error("Erro durante a sincronização:", error);
    }
}

// Agendar o processo de sincronização para ser executado a cada 1 hora
cron.schedule("0 * * * *", () => {
    logger.info("Executando sincronização agendada");
    syncAsaasToNotion();
});

// Executar o processo de sincronização imediatamente quando o script é executado
syncAsaasToNotion();

// Tratamento de erros não capturados
process.on("unhandledRejection", (reason, promise) => {
    logger.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
    logger.error("Uncaught Exception:", error);
    // Encerrar o processo ou não
    // process.exit(1);
});
