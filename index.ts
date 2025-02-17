import express from 'express';
import cors from 'cors';

const app = express();
const PORT = 3001;

// Habilita CORS e o parser de JSON para o corpo das requisições
app.use(cors());
app.use(express.json());

/**
 * Interface que define a estrutura de uma ordem.
 * Acrescentamos a propriedade "status" para controlar se a ordem está "open", "partial" ou "executed".
 */
interface Order {
  id: number;
  type: 'buy' | 'sell';
  asset: 'HYPE' | 'FLOP';
  price: number;
  amount: number; // Para compra: valor total investido; para venda: ganho potencial
  shares: number; // Quantidade de ações
  potentialGain?: number; // Apenas para ordens de venda
  status?: 'open' | 'partial' | 'executed';
}

// O orderBook armazena as ordens em memória
let orderBook: Order[] = [];

/**
 * Função para ordenar ordens conforme o tipo:
 * - Ordens de venda: em ordem crescente de preço (menor preço primeiro).
 * - Ordens de compra: em ordem decrescente de preço (maior preço primeiro).
 */
const sortOrders = (orders: Order[], orderType: 'buy' | 'sell') => {
  const sorted = orders
    .filter(order => order.type === orderType)
    .sort((a, b) => orderType === 'sell' ? a.price - b.price : b.price - a.price);
  console.log(`[sortOrders] Ordenadas ${orderType} orders:`, sorted);
  return sorted;
};

/**
 * Função auxiliar para atualizar o orderBook, garantindo que as ordens do tipo informado
 * sejam sempre ordenadas de acordo com a função sortOrders.
 */
const updateSortedOrders = (orderType: 'buy' | 'sell') => {
  if (orderType === 'buy') {
    const sortedBuy = sortOrders(orderBook, 'buy');
    const sellOrders = orderBook.filter(order => order.type !== 'buy');
    orderBook = [...sortedBuy, ...sellOrders];
  } else {
    const sortedSell = sortOrders(orderBook, 'sell');
    const buyOrders = orderBook.filter(order => order.type !== 'sell');
    orderBook = [...buyOrders, ...sortedSell];
  }
};

/**
 * Função que executa o matching para uma ordem limite de COMPRA.
 * Se houver ordens de venda (limit) com preço menor ou igual ao preço da ordem de compra,
 * o sistema executa a ordem como se fosse a mercado.
 * Durante o matching, as ordens consumidas são atualizadas:
 * - Se parcialmente preenchidas: o "shares" é decrementado e o status é "partial".
 * - Se totalmente preenchidas: o status é "executed" e a ordem será removida do orderBook.
 *
 * Retorna um objeto com os detalhes da execução, incluindo as operações realizadas e,
 * se a ordem não for totalmente preenchida, o restante da ordem (a ser adicionada no orderBook).
 */
function matchLimitBuyOrder(newBuy: Order) {
  console.log(`[matchLimitBuyOrder] Iniciando matching para ordem de COMPRA:`, newBuy);
  // Filtra as ordens de venda que podem casar: mesmo ativo e preço menor ou igual ao preço da compra
  let matchingSellOrders = orderBook.filter(
    o => o.type === 'sell' && o.asset === newBuy.asset && o.price <= newBuy.price
  );
  // Ordena as ordens de venda do menor para o maior preço
  matchingSellOrders.sort((a, b) => a.price - b.price);

  let remainingShares = newBuy.shares; // quantidade que queremos comprar
  let totalCost = 0;
  let executedTrades: any[] = []; // detalhes de cada trade executado

  for (let sellOrder of matchingSellOrders) {
    if (remainingShares <= 0) break;
    const availableShares = sellOrder.shares;
    const executedShares = Math.min(remainingShares, availableShares);
    const tradeCost = executedShares * sellOrder.price;
    totalCost += tradeCost;
    remainingShares -= executedShares;

    // Atualiza a ordem de venda consumida
    sellOrder.shares -= executedShares;
    sellOrder.amount = +(sellOrder.shares * sellOrder.price).toFixed(2);
    if (sellOrder.shares === 0) {
      sellOrder.status = 'executed';
      console.log(`[matchLimitBuyOrder] Ordem de venda ${sellOrder.id} totalmente executada.`);
    } else {
      sellOrder.status = 'partial';
      console.log(`[matchLimitBuyOrder] Ordem de venda ${sellOrder.id} parcialmente executada. Restam ${sellOrder.shares} ações.`);
    }
    executedTrades.push({
      sellOrderId: sellOrder.id,
      executedShares,
      price: sellOrder.price,
      tradeCost
    });
  }

  const executedSharesTotal = newBuy.shares - remainingShares;
  const averagePrice = executedSharesTotal > 0 ? totalCost / executedSharesTotal : 0;

  // Prepara o resultado do matching
  const result: any = {
    newOrderId: newBuy.id,
    executedShares: executedSharesTotal,
    averagePrice: +averagePrice.toFixed(4),
    trades: executedTrades
  };

  if (remainingShares > 0) {
    // Ordem não foi totalmente preenchida: atualiza a ordem com o restante e marca como "partial"
    newBuy.shares = remainingShares;
    newBuy.amount = +(remainingShares * newBuy.price).toFixed(2);
    newBuy.status = 'partial';
    result.remainingOrder = newBuy;
    console.log(`[matchLimitBuyOrder] Ordem de compra ${newBuy.id} parcialmente executada. Restam ${remainingShares} ações.`);
  } else {
    // Ordem totalmente preenchida
    newBuy.status = 'executed';
    result.remainingOrder = null;
    console.log(`[matchLimitBuyOrder] Ordem de compra ${newBuy.id} totalmente executada.`);
  }

  return result;
}

/**
 * Função que executa o matching para uma ordem limite de VENDA.
 * Verifica se há ordens de compra (limit) com preço maior ou igual ao preço da venda.
 * Durante o matching, as ordens consumidas são atualizadas de forma semelhante ao match de compra.
 */
function matchLimitSellOrder(newSell: Order) {
  console.log(`[matchLimitSellOrder] Iniciando matching para ordem de VENDA:`, newSell);
  // Filtra as ordens de compra que podem casar: mesmo ativo e preço maior ou igual ao preço da venda
  let matchingBuyOrders = orderBook.filter(
    o => o.type === 'buy' && o.asset === newSell.asset && o.price >= newSell.price
  );
  // Ordena as ordens de compra do maior para o menor preço
  matchingBuyOrders.sort((a, b) => b.price - a.price);

  let remainingShares = newSell.shares; // quantidade que queremos vender
  let totalRevenue = 0;
  let executedTrades: any[] = [];

  for (let buyOrder of matchingBuyOrders) {
    if (remainingShares <= 0) break;
    const availableShares = buyOrder.shares;
    const executedShares = Math.min(remainingShares, availableShares);
    // Para a venda, o trade é executado pelo preço da ordem de compra (ou pode ser negociado pelo preço da venda)
    const tradeRevenue = executedShares * buyOrder.price;
    totalRevenue += tradeRevenue;
    remainingShares -= executedShares;

    // Atualiza a ordem de compra consumida
    buyOrder.shares -= executedShares;
    buyOrder.amount = +(buyOrder.shares * buyOrder.price).toFixed(2);
    if (buyOrder.shares === 0) {
      buyOrder.status = 'executed';
      console.log(`[matchLimitSellOrder] Ordem de compra ${buyOrder.id} totalmente executada.`);
    } else {
      buyOrder.status = 'partial';
      console.log(`[matchLimitSellOrder] Ordem de compra ${buyOrder.id} parcialmente executada. Restam ${buyOrder.shares} ações.`);
    }
    executedTrades.push({
      buyOrderId: buyOrder.id,
      executedShares,
      price: buyOrder.price,
      tradeRevenue
    });
  }

  const executedSharesTotal = newSell.shares - remainingShares;
  const averagePrice = executedSharesTotal > 0 ? totalRevenue / executedSharesTotal : 0;

  const result: any = {
    newOrderId: newSell.id,
    executedShares: executedSharesTotal,
    averagePrice: +averagePrice.toFixed(4),
    trades: executedTrades
  };

  if (remainingShares > 0) {
    newSell.shares = remainingShares;
    newSell.amount = +(remainingShares * newSell.price).toFixed(2);
    newSell.potentialGain = newSell.amount;
    newSell.status = 'partial';
    result.remainingOrder = newSell;
    console.log(`[matchLimitSellOrder] Ordem de venda ${newSell.id} parcialmente executada. Restam ${remainingShares} ações.`);
  } else {
    newSell.status = 'executed';
    result.remainingOrder = null;
    console.log(`[matchLimitSellOrder] Ordem de venda ${newSell.id} totalmente executada.`);
  }

  return result;
}

/**
 * Rota para COMPRA a mercado de HYPE
 * (Mantida para execução imediata com liquidez já existente no orderBook)
 */
app.post('/market-buy-hype', (req, res) => {
  console.log(`[Route /market-buy-hype] Requisição recebida:`, req.body);
  const { amount } = req.body;
  if (amount === undefined) {
    console.log(`[Route /market-buy-hype] Erro: Amount is required.`);
    return res.status(400).json({ error: 'Amount is required.' });
  }
  const hypeResult = executeMarketBuyHype(amount);
  const flopResult = executeFlopBuyImpact(amount);
  if (hypeResult.error && flopResult.error) {
    console.log(`[Route /market-buy-hype] Erro: Liquidez insuficiente.`);
    return res.status(400).json({ error: 'Not enough liquidity to execute the market buy.' });
  }
  let finalResult = hypeResult.priceFinal <= flopResult.priceFinal ? hypeResult : flopResult;
  console.log(`[Route /market-buy-hype] Ordem a mercado executada:`, finalResult);
  res.status(201).json(finalResult);
});

/**
 * Rota para COMPRA a mercado de FLOP
 */
app.post('/market-buy-flop', (req, res) => {
  console.log(`[Route /market-buy-flop] Requisição recebida:`, req.body);
  const { amount } = req.body;
  if (amount === undefined) {
    console.log(`[Route /market-buy-flop] Erro: Amount is required.`);
    return res.status(400).json({ error: 'Amount is required.' });
  }
  const flopResult = executeMarketBuyFlop(amount);
  const hypeResult = executeHypeBuyImpact(amount);
  if (flopResult.error && hypeResult.error) {
    console.log(`[Route /market-buy-flop] Erro: Liquidez insuficiente.`);
    return res.status(400).json({ error: 'Not enough liquidity to execute the market buy.' });
  }
  let finalResult = flopResult.priceFinal <= hypeResult.priceFinal ? flopResult : hypeResult;
  console.log(`[Route /market-buy-flop] Ordem a mercado executada:`, finalResult);
  res.status(201).json(finalResult);
});

/**
 * Rota para VENDA a mercado de HYPE
 */
app.post('/market-sell-hype', (req, res) => {
  console.log(`[Route /market-sell-hype] Requisição recebida:`, req.body);
  const { shares } = req.body;
  if (shares === undefined) {
    console.log(`[Route /market-sell-hype] Erro: Shares is required.`);
    return res.status(400).json({ error: 'Shares is required.' });
  }
  const result = executeMarketSellHype(shares);
  if (result.error) {
    console.log(`[Route /market-sell-hype] Erro: ${result.error}`);
    return res.status(400).json(result);
  }
  // Remove do orderBook as ordens que foram totalmente executadas
  orderBook = orderBook.filter(o => o.status !== 'executed');
  console.log(`[Route /market-sell-hype] Ordem a mercado executada:`, result);
  res.status(201).json(result);
});

/**
 * Rota para VENDA a mercado de FLOP
 */
app.post('/market-sell-flop', (req, res) => {
  console.log(`[Route /market-sell-flop] Requisição recebida:`, req.body);
  const { shares } = req.body;
  if (shares === undefined) {
    console.log(`[Route /market-sell-flop] Erro: Shares is required.`);
    return res.status(400).json({ error: 'Shares is required.' });
  }
  const result = executeMarketSellFlop(shares);
  if (result.error) {
    console.log(`[Route /market-sell-flop] Erro: ${result.error}`);
    return res.status(400).json(result);
  }
  orderBook = orderBook.filter(o => o.status !== 'executed');
  console.log(`[Route /market-sell-flop] Ordem a mercado executada:`, result);
  res.status(201).json(result);
});

/**
 * Rota para criação de uma ordem LIMITE de COMPRA.
 * Se houver matching, a execução é realizada e, se houver remanescente da ordem,
 * este é adicionado ao orderBook. Em ambos os casos, as ordens de compra são reordenadas.
 */
app.post('/buy', (req, res) => {
  console.log(`[Route /buy] Requisição recebida:`, req.body);
  const { asset, price, amount } = req.body;
  if (!asset || price === undefined || amount === undefined) {
    console.log(`[Route /buy] Erro: Asset, price, and amount are required.`);
    return res.status(400).json({ error: 'Asset, price, and amount are required.' });
  }
  if (price <= 0 || price > 1) {
    console.log(`[Route /buy] Erro: Preço fora do intervalo permitido.`);
    return res.status(400).json({ error: 'Price must be between 0 and 1 in increments of 0.01.' });
  }
  const shares = +(amount / price).toFixed(4);
  let newOrder: Order = {
    id: Date.now(),
    type: 'buy',
    asset,
    price,
    amount,
    shares,
    status: 'open'
  };

  // Verifica se existe alguma ordem de venda que possa casar (preço menor ou igual)
  const matchingSell = orderBook.find(
    o => o.type === 'sell' && o.asset === asset && o.price <= price
  );

  if (matchingSell) {
    console.log(`[Route /buy] Encontrada ordem de venda compatível. Executando matching a mercado.`);
    const result = matchLimitBuyOrder(newOrder);
    // Remove as ordens que foram totalmente executadas do orderBook
    orderBook = orderBook.filter(o => o.status !== 'executed');
    if (result.remainingOrder) {
      orderBook.push(result.remainingOrder);
      // Atualiza as ordens de compra com o sortOrders
      updateSortedOrders('buy');
      console.log(`[Route /buy] Remanescente da ordem de compra adicionada e ordenada:`, result.remainingOrder);
    }
    return res.status(201).json(result);
  } else {
    orderBook.push(newOrder);
    // Atualiza as ordens de compra com o sortOrders
    updateSortedOrders('buy');
    console.log(`[Route /buy] Ordem de compra adicionada e ordenada:`, newOrder);
    return res.status(201).json(newOrder);
  }
});

/**
 * Rota para criação de uma ordem LIMITE de VENDA.
 * Se houver matching, a execução é realizada e, se houver remanescente da ordem,
 * este é adicionado ao orderBook. Em ambos os casos, as ordens de venda são reordenadas.
 */
app.post('/sell', (req, res) => {
  console.log(`[Route /sell] Requisição recebida:`, req.body);
  const { asset, price, shares } = req.body;
  if (!asset || price === undefined || shares === undefined) {
    console.log(`[Route /sell] Erro: Asset, price, and shares are required.`);
    return res.status(400).json({ error: 'Asset, price, and shares are required.' });
  }
  if (price <= 0 || price > 1) {
    console.log(`[Route /sell] Erro: Preço fora do intervalo permitido.`);
    return res.status(400).json({ error: 'Price must be between 0 and 1 in increments of 0.01.' });
  }
  const potentialGain = +(shares * price).toFixed(2);
  let newOrder: Order = {
    id: Date.now(),
    type: 'sell',
    asset,
    price,
    amount: potentialGain,
    shares,
    potentialGain,
    status: 'open'
  };

  // Verifica se há ordem de compra com preço maior ou igual
  const matchingBuy = orderBook.find(
    o => o.type === 'buy' && o.asset === asset && o.price >= price
  );

  if (matchingBuy) {
    console.log(`[Route /sell] Encontrada ordem de compra compatível. Executando matching a mercado.`);
    const result = matchLimitSellOrder(newOrder);
    orderBook = orderBook.filter(o => o.status !== 'executed');
    if (result.remainingOrder) {
      orderBook.push(result.remainingOrder);
      // Atualiza as ordens de venda com o sortOrders
      updateSortedOrders('sell');
      console.log(`[Route /sell] Remanescente da ordem de venda adicionada e ordenada:`, result.remainingOrder);
    }
    return res.status(201).json(result);
  } else {
    orderBook.push(newOrder);
    // Atualiza as ordens de venda com o sortOrders
    updateSortedOrders('sell');
    console.log(`[Route /sell] Ordem de venda adicionada e ordenada:`, newOrder);
    return res.status(201).json(newOrder);
  }
});

/**
 * Rota para listar as ordens ativas (somente as que não estão "executed").
 */
app.get('/orders', (_req, res) => {
  console.log(`[Route /orders] Listando ordens ativas.`);
  const activeOrders = orderBook.filter(o => o.status !== 'executed');
  res.json(activeOrders);
});

// Inicia o servidor e exibe uma mensagem de confirmação
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

/* 
-----------------------------------------------------------
Funções auxiliares de mercado (mantidas do código anterior):
-----------------------------------------------------------
*/

/**
 * Executa a compra a mercado de HYPE, utilizando as ordens de venda de HYPE.
 */
const executeMarketBuyHype = (amount: number) => {
  console.log(`[executeMarketBuyHype] Iniciando compra a mercado de HYPE para amount: ${amount}`);
  let remainingAmount = amount;
  let totalShares = 0;
  let priceFinal = 0;
  let priceImpact = 0;

  const sellOrders = sortOrders(orderBook, 'sell').filter(order => order.asset === 'HYPE');
  console.log(`[executeMarketBuyHype] Ordens de venda de HYPE disponíveis:`, sellOrders);

  for (const order of sellOrders) {
    if (remainingAmount <= 0) break;
    const tradableAmount = Math.min(order.amount, remainingAmount);
    totalShares += tradableAmount / order.price;
    priceFinal = order.price;
    remainingAmount -= tradableAmount;
    console.log(`[executeMarketBuyHype] TradableAmount: ${tradableAmount}, TotalShares: ${totalShares}, PriceFinal: ${priceFinal}, RemainingAmount: ${remainingAmount}`);
  }

  if (remainingAmount > 0) {
    console.log(`[executeMarketBuyHype] Liquidez insuficiente para HYPE.`);
    return { error: 'Not enough liquidity to execute the market buy.' };
  }

  priceImpact = priceFinal - (sellOrders[0]?.price || priceFinal);
  console.log(`[executeMarketBuyHype] Compra concluída: TotalShares: ${totalShares}, PriceFinal: ${priceFinal}, PriceImpact: ${priceImpact}`);
  return { totalShares, priceFinal, priceImpact };
};

/**
 * Executa a compra de HYPE utilizando ordens de compra de FLOP (matching cruzado).
 */
const executeFlopBuyImpact = (amount: number) => {
  console.log(`[executeFlopBuyImpact] Iniciando compra de HYPE via ordens de FLOP para amount: ${amount}`);
  let remainingAmount = amount;
  let totalShares = 0;
  let priceFinal = 0;

  const buyOrdersFlop = sortOrders(orderBook, 'buy').filter(order => order.asset === 'FLOP');
  console.log(`[executeFlopBuyImpact] Ordens de compra de FLOP disponíveis:`, buyOrdersFlop);

  for (const order of buyOrdersFlop) {
    const priceOposto = 1 - order.price;
    const requiredShares = amount / priceOposto;
    console.log(`[executeFlopBuyImpact] PriceOposto: ${priceOposto}, RequiredShares: ${requiredShares}, OrderShares: ${order.shares}`);

    if (order.shares >= requiredShares) {
      totalShares += requiredShares;
      priceFinal = priceOposto;
      remainingAmount = 0;
      console.log(`[executeFlopBuyImpact] Ordem completa: TotalShares: ${totalShares}, PriceFinal: ${priceFinal}`);
      break;
    } else {
      const tradableShares = order.shares;
      const tradableAmount = tradableShares * priceOposto;
      totalShares += tradableShares;
      remainingAmount -= tradableAmount;
      console.log(`[executeFlopBuyImpact] Parcial: TradableShares: ${tradableShares}, TradableAmount: ${tradableAmount}, RemainingAmount: ${remainingAmount}`);
    }
  }

  if (remainingAmount > 0) {
    console.log(`[executeFlopBuyImpact] Liquidez insuficiente em FLOP.`);
    return { error: 'Not enough liquidity in FLOP to execute the market buy.' };
  }

  return { totalShares, priceFinal };
};

/**
 * Executa a compra a mercado de FLOP, utilizando as ordens de venda de FLOP.
 */
const executeMarketBuyFlop = (amount: number) => {
  console.log(`[executeMarketBuyFlop] Iniciando compra a mercado de FLOP para amount: ${amount}`);
  let remainingAmount = amount;
  let totalShares = 0;
  let priceFinal = 0;
  let priceImpact = 0;

  const sellOrders = sortOrders(orderBook, 'sell').filter(order => order.asset === 'FLOP');
  console.log(`[executeMarketBuyFlop] Ordens de venda de FLOP disponíveis:`, sellOrders);

  for (const order of sellOrders) {
    if (remainingAmount <= 0) break;
    const tradableAmount = Math.min(order.amount, remainingAmount);
    totalShares += tradableAmount / order.price;
    priceFinal = order.price;
    remainingAmount -= tradableAmount;
    console.log(`[executeMarketBuyFlop] TradableAmount: ${tradableAmount}, TotalShares: ${totalShares}, PriceFinal: ${priceFinal}, RemainingAmount: ${remainingAmount}`);
  }

  if (remainingAmount > 0) {
    console.log(`[executeMarketBuyFlop] Liquidez insuficiente para FLOP.`);
    return { error: 'Not enough liquidity to execute the market buy.' };
  }

  priceImpact = priceFinal - (sellOrders[0]?.price || priceFinal);
  console.log(`[executeMarketBuyFlop] Compra concluída: TotalShares: ${totalShares}, PriceFinal: ${priceFinal}, PriceImpact: ${priceImpact}`);
  return { totalShares, priceFinal, priceImpact };
};

/**
 * Executa a compra de FLOP utilizando ordens de compra de HYPE (matching cruzado).
 */
const executeHypeBuyImpact = (amount: number) => {
  console.log(`[executeHypeBuyImpact] Iniciando compra de FLOP via ordens de HYPE para amount: ${amount}`);
  let remainingAmount = amount;
  let totalShares = 0;
  let priceFinal = 0;

  const buyOrdersHype = sortOrders(orderBook, 'buy').filter(order => order.asset === 'HYPE');
  console.log(`[executeHypeBuyImpact] Ordens de compra de HYPE disponíveis:`, buyOrdersHype);

  for (const order of buyOrdersHype) {
    const priceOposto = 1 - order.price;
    const requiredShares = amount / priceOposto;
    console.log(`[executeHypeBuyImpact] PriceOposto: ${priceOposto}, RequiredShares: ${requiredShares}, OrderShares: ${order.shares}`);

    if (order.shares >= requiredShares) {
      totalShares += requiredShares;
      priceFinal = priceOposto;
      remainingAmount = 0;
      console.log(`[executeHypeBuyImpact] Ordem completa: TotalShares: ${totalShares}, PriceFinal: ${priceFinal}`);
      break;
    } else {
      const tradableShares = order.shares;
      const tradableAmount = tradableShares * priceOposto;
      totalShares += tradableShares;
      remainingAmount -= tradableAmount;
      console.log(`[executeHypeBuyImpact] Parcial: TradableShares: ${tradableShares}, TradableAmount: ${tradableAmount}, RemainingAmount: ${remainingAmount}`);
    }
  }

  if (remainingAmount > 0) {
    console.log(`[executeHypeBuyImpact] Liquidez insuficiente em HYPE.`);
    return { error: 'Not enough liquidity in HYPE to execute the market buy.' };
  }

  return { totalShares, priceFinal };
};

/**
 * Executa a venda a mercado de HYPE, utilizando as ordens de compra de HYPE.
 */
const executeMarketSellHype = (shares: number) => {
  console.log(`[executeMarketSellHype] Iniciando venda a mercado de HYPE para shares: ${shares}`);
  let remainingShares = shares;
  let totalRevenue = 0;
  let executedTrades: any[] = [];

  // Filtra as ordens de compra de HYPE, ordenando por preço decrescente (maior preço primeiro)
  const buyOrders = sortOrders(orderBook, 'buy').filter(order => order.asset === 'HYPE');
  console.log(`[executeMarketSellHype] Ordens de compra de HYPE disponíveis:`, buyOrders);

  for (const order of buyOrders) {
    if (remainingShares <= 0) break;
    const availableShares = order.shares;
    const executedShares = Math.min(remainingShares, availableShares);
    const tradeRevenue = executedShares * order.price;
    totalRevenue += tradeRevenue;
    remainingShares -= executedShares;

    // Atualiza a ordem de compra consumida
    order.shares -= executedShares;
    order.amount = +(order.shares * order.price).toFixed(2);
    if (order.shares === 0) {
      order.status = 'executed';
      console.log(`[executeMarketSellHype] Ordem de compra ${order.id} totalmente executada.`);
    } else {
      order.status = 'partial';
      console.log(`[executeMarketSellHype] Ordem de compra ${order.id} parcialmente executada. Restam ${order.shares} ações.`);
    }
    executedTrades.push({
      buyOrderId: order.id,
      executedShares,
      price: order.price,
      tradeRevenue
    });
  }

  const executedSharesTotal = shares - remainingShares;
  const averagePrice = executedSharesTotal > 0 ? totalRevenue / executedSharesTotal : 0;

  if (remainingShares > 0) {
    console.log(`[executeMarketSellHype] Liquidez insuficiente para HYPE.`);
    return { error: 'Not enough liquidity to execute the market sell.' };
  }

  console.log(`[executeMarketSellHype] Venda concluída: ExecutedShares: ${executedSharesTotal}, TotalRevenue: ${totalRevenue}, AveragePrice: ${+averagePrice.toFixed(4)}`);
  return { executedShares: executedSharesTotal, totalRevenue, averagePrice: +averagePrice.toFixed(4), trades: executedTrades };
};

/**
 * Executa a venda a mercado de FLOP, utilizando as ordens de compra de FLOP.
 */
const executeMarketSellFlop = (shares: number) => {
  console.log(`[executeMarketSellFlop] Iniciando venda a mercado de FLOP para shares: ${shares}`);
  let remainingShares = shares;
  let totalRevenue = 0;
  let executedTrades: any[] = [];

  // Filtra as ordens de compra de FLOP, ordenando por preço decrescente (maior preço primeiro)
  const buyOrders = sortOrders(orderBook, 'buy').filter(order => order.asset === 'FLOP');
  console.log(`[executeMarketSellFlop] Ordens de compra de FLOP disponíveis:`, buyOrders);

  for (const order of buyOrders) {
    if (remainingShares <= 0) break;
    const availableShares = order.shares;
    const executedShares = Math.min(remainingShares, availableShares);
    const tradeRevenue = executedShares * order.price;
    totalRevenue += tradeRevenue;
    remainingShares -= executedShares;

    // Atualiza a ordem de compra consumida
    order.shares -= executedShares;
    order.amount = +(order.shares * order.price).toFixed(2);
    if (order.shares === 0) {
      order.status = 'executed';
      console.log(`[executeMarketSellFlop] Ordem de compra ${order.id} totalmente executada.`);
    } else {
      order.status = 'partial';
      console.log(`[executeMarketSellFlop] Ordem de compra ${order.id} parcialmente executada. Restam ${order.shares} ações.`);
    }
    executedTrades.push({
      buyOrderId: order.id,
      executedShares,
      price: order.price,
      tradeRevenue
    });
  }

  const executedSharesTotal = shares - remainingShares;
  const averagePrice = executedSharesTotal > 0 ? totalRevenue / executedSharesTotal : 0;

  if (remainingShares > 0) {
    console.log(`[executeMarketSellFlop] Liquidez insuficiente para FLOP.`);
    return { error: 'Not enough liquidity to execute the market sell.' };
  }

  console.log(`[executeMarketSellFlop] Venda concluída: ExecutedShares: ${executedSharesTotal}, TotalRevenue: ${totalRevenue}, AveragePrice: ${+averagePrice.toFixed(4)}`);
  return { executedShares: executedSharesTotal, totalRevenue, averagePrice: +averagePrice.toFixed(4), trades: executedTrades };
};
