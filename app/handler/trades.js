const TradeOfferManager = require('steam-tradeoffer-manager');
const Currencies = require('tf2-currencies');
const pluralize = require('pluralize');

const log = require('lib/logger');
const inventory = require('app/inventory');
const prices = require('app/prices');
const listings = require('handler/listings');
const client = require('lib/client');
const manager = require('lib/manager');
const admin = require('app/admins');

const isAdmin = admin.isAdmin;
const checkBanned = require('utils/isBanned');

exports.getActiveOffer = function (steamID) {
    const pollData = require('lib/manager').pollData;

    if (!pollData.offerData) {
        return null;
    }

    const steamID64 = typeof steamID === 'string' ? steamID : steamID.getSteamID64();

    for (const id in pollData.sent) {
        if (!Object.prototype.hasOwnProperty.call(pollData.sent, id)) {
            continue;
        }

        if (pollData.sent[id] !== TradeOfferManager.ETradeOfferState.Active) {
            continue;
        }

        const data = pollData.offerData[id] || null;
        if (data === null) {
            continue;
        }

        if (data.partner === steamID64) {
            return id;
        }
    }

    return null;
};

exports.createOffer = function (details, callback) {
    const partner = details.steamid;
    const match = prices.get(details.sku, true);

    const start = new Date().getTime();

    if (match === null) {
        callback(null, 'The item is no longer in the pricelist');
        return;
    }

    const intent = details.buying ? 0 : 1;

    if (match.intent !== 2 && match.intent !== intent) {
        callback(null, 'I am only ' + (details.buying ? 'selling' : 'buying') + ' ' + pluralize(match.name));
        return;
    }

    const amountCanTrade = inventory.amountCanTrade(details.sku, details.buying);

    if (amountCanTrade === 0) {
        // Can't trade the item at all
        callback(null, 'I can\'t ' + (details.buying ? 'buy' : 'sell') + ' any ' + pluralize(match.name));
        return;
    }

    const buyer = details.buying ? client.steamID.getSteamID64() : details.steamid;
    const seller = details.buying ? details.steamid : client.steamID.getSteamID64();

    inventory.getDictionary(seller, false, function (err, sellerDict) {
        if (err) {
            return callback(err);
        }

        const sellerItems = (sellerDict[match.sku] || []);

        // TODO: Return inventory class instead of object

        let amount = details.amount;

        let alteredMessage;

        if (sellerItems.length === 0) {
            // Seller does not have the item
            return callback(null, (details.buying ? 'You' : 'I') + ' don\'t have any ' + pluralize(match.name, 2));
        } else if (sellerItems.length < amount) {
            // Seller has the item, but not enough
            alteredMessage = (details.buying ? 'You' : 'I') + ' only have ' + pluralize(match.name, sellerItems.length, true);
            amount = sellerItems.length;
        }

        // Check if we can buy / sell that many
        if (amountCanTrade < amount) {
            // We can trade the item, but not the asked amount
            alteredMessage = 'I can only ' + (details.buying ? 'buy' : 'sell') + ' ' + pluralize(match.name, amountCanTrade, true);
            amount = amountCanTrade;
        }

        inventory.getDictionary(buyer, false, function (err, buyerDict) {
            if (err) {
                return callback(err);
            }

            const buyerCurrenciesWithAssetids = inventory.getCurrencies(buyerDict);
            const buyerCurrencies = inventory.getCurrencies(buyerDict, true);

            // Check if the buyer can afford the items

            const isKey = match.sku === '5021;6';

            const canAfford = prices.amountCanAfford(details.buying, !isKey, match[details.buying ? 'buy' : 'sell'], buyerCurrencies);

            if (canAfford === 0) {
                return callback(null, (details.buying ? 'I' : 'You') + ' don\'t have enough pure to buy any ' + pluralize(match.name, 2));
            } else if (canAfford < amount) {
                alteredMessage = (details.buying ? 'I' : 'You') + ' can only afford ' + pluralize(match.name, canAfford, true);
                amount = canAfford;
            }

            if (alteredMessage) {
                client.chatMessage(partner, 'Your offer has been altered! Reason: ' + alteredMessage + '.');
            }

            const keyPrices = prices.getKeyPrices();
            const keyPrice = keyPrices[details.buying ? 'buy' : 'sell'].metal;

            const price = Currencies.toCurrencies(match[details.buying ? 'buy' : 'sell'].toValue(isKey ? undefined : keyPrice) * amount, isKey ? undefined : keyPrice);

            // Figurated out what items to add to the offer
            const required = constructOffer(buyerCurrencies, price, details.buying, !isKey);

            if (required.change > 0) {
                log.warn('Failed to create offer because change is postive');
                return callback(null, 'Something went wrong constructing the offer, try again later');
            }

            const buyerCurrenciesPay = new Currencies({
                keys: required.currencies['5021;6'],
                metal: Currencies.toRefined((required.currencies['5002;6'] || 0) * 9 + (required.currencies['5001;6'] || 0) * 3 + (required.currencies['5000;6'] || 0))
            });

            const buyerStr = buyerCurrenciesPay.toString();

            const sellerStr = pluralize(match.name, amount, true) + (required.change === 0 ? '' : ' and ' + Currencies.toRefined(Math.abs(required.change)) + ' ref');

            client.chatMessage(partner, 'Please wait while I process your offer! You will be offered ' + (details.buying ? buyerStr : sellerStr) + ' for your ' + (details.buying ? sellerStr : buyerStr));

            const offer = manager.createOffer(partner);

            offer.data('partner', partner);

            // Add items to offer

            const exchange = {
                our: { value: 0, keys: 0, scrap: 0 },
                their: { value: 0, keys: 0, scrap: 0 }
            };

            exchange[details.buying ? 'our' : 'their'].value = buyerCurrenciesPay.toValue(keyPrice);
            exchange[details.buying ? 'our' : 'their'].keys = buyerCurrenciesPay.keys;
            exchange[details.buying ? 'our' : 'their'].scrap = Currencies.toScrap(buyerCurrenciesPay.metal);

            const itemsDict = { our: {}, their: {} };

            let remainingItems = amount;

            for (let i = 0; i < sellerItems[i]; i++) {
                if (offer[details.buying ? 'addTheirItem' : 'addMyItem']({
                    assetid: sellerItems[i],
                    appid: 440,
                    contextid: 2,
                    amount: 1
                })) {
                    remainingItems--;
                    if (remainingItems === 0) {
                        break;
                    }
                }
            }

            if (remainingItems !== 0) {
                log.warn('Failed to create offer because seller items');
                return callback(null, 'Something went wrong constructing the offer, try again later');
            }

            itemsDict[details.buying ? 'their' : 'our'][match.sku] = amount;
            exchange[details.buying ? 'their' : 'our'].value = price.toValue(isKey ? undefined : keyPrice);
            exchange[details.buying ? 'their' : 'our'].scrap = exchange[details.buying ? 'their' : 'our'].value;

            if (required.change !== 0) {
                let change = Math.abs(required.change);

                exchange[details.buying ? 'their' : 'our'].value += change;
                exchange[details.buying ? 'their' : 'our'].scrap += change;

                const currencies = inventory.getCurrencies(sellerDict);
                // We won't use keys when giving change
                delete currencies['5021;6'];

                for (const sku in currencies) {
                    if (!Object.prototype.hasOwnProperty.call(currencies, sku)) {
                        continue;
                    }

                    const whose = details.buying ? 'their' : 'our';

                    let value = 0;

                    if (sku === '5002;6') {
                        value = 9;
                    } else if (sku === '5001;6') {
                        value = 3;
                    } else if (sku === '5000;6') {
                        value = 1;
                    }

                    if (change / value >= 1) {
                        for (let i = 0; i < currencies[sku].length; i++) {
                            if (offer[details.buying ? 'addTheirItem' : 'addMyItem']({
                                assetid: currencies[sku][i],
                                appid: 440,
                                contextid: 2,
                                amount: 1
                            })) {
                                itemsDict[whose][sku] = (itemsDict[whose][sku] || 0) + 1;
                                change -= value;
                                if (change < value) {
                                    break;
                                }
                            }
                        }
                    }
                }

                if (change !== 0) {
                    return callback(null, 'I am missing ' + Currencies.toRefined(change) + ' ref as change');
                }
            }

            const requiredCurrencies = required.currencies;

            for (const sku in requiredCurrencies) {
                if (!Object.prototype.hasOwnProperty.call(requiredCurrencies, sku)) {
                    continue;
                }

                itemsDict[details.buying ? 'our' : 'their'][sku] = requiredCurrencies[sku];

                for (let i = 0; i < buyerCurrenciesWithAssetids[sku].length; i++) {
                    if (offer[details.buying ? 'addMyItem' : 'addTheirItem']({
                        assetid: buyerCurrenciesWithAssetids[sku][i],
                        appid: 440,
                        contextid: 2,
                        amount: 1
                    })) {
                        requiredCurrencies[sku]--;
                        if (requiredCurrencies[sku] === 0) {
                            break;
                        }
                    }
                }

                if (requiredCurrencies[sku] !== 0) {
                    log.warn('Failed to create offer because missing buyer pure');
                    return callback(null, 'Something went wrong constructing the offer, try again later');
                }
            }

            const itemsDiff = {};

            ['our', 'their'].forEach(function (whose) {
                for (const sku in itemsDict[whose]) {
                    if (!Object.prototype.hasOwnProperty.call(itemsDict[whose], sku)) {
                        continue;
                    }

                    itemsDiff[sku] = (itemsDiff[sku] || 0) + itemsDict[whose][sku] * (whose === 'our' ? -1 : 1);
                }
            });

            offer.data('diff', itemsDiff);
            offer.data('dict', itemsDict);
            offer.data('value', {
                our: {
                    keys: exchange.our.keys,
                    metal: Currencies.toRefined(exchange.our.scrap)
                },
                their: {
                    keys: exchange.their.keys,
                    metal: Currencies.toRefined(exchange.their.scrap)
                },
                rates: {
                    buy: keyPrices.buy.metal,
                    sell: keyPrices.sell.metal
                }
            });

            const itemPrices = {};

            itemPrices[match.sku] = {
                buy: match.buy,
                sell: match.sell
            };

            offer.data('prices', itemPrices);

            offer.log('info', 'checking escrow...');

            checkEscrow(offer, function (err, hasEscrow) {
                if (err) {
                    log.warn('Failed to check escrow', err);
                    return callback(err);
                }

                if (hasEscrow) {
                    offer.log('info', 'would be held if accepted, declining...');
                    return callback(null, 'The offer would be held by escrow');
                }

                offer.log('info', 'checking bans...');

                checkBanned(partner, function (err, isBanned) {
                    if (err) {
                        return callback(err);
                    }

                    if (isBanned) {
                        offer.log('info', 'partner is banned in one or more communities, declining...');
                        return callback(null, 'You are banned in one or more communities');
                    }

                    offer.data('handleTimestamp', start);

                    require('app/trade').sendOffer(offer, function (err) {
                        if (err) {
                            if (err.message.indexOf('We were unable to contact the game\'s item server') !== -1) {
                                return callback(null, 'Team Fortress 2\'s item server may be down or Steam may be experiencing temporary connectivity issues');
                            } else if (err.message.indexOf('can only be sent to friends') != -1) {
                                return callback(err);
                            } else if (err.message.indexOf('maximum number of items allowed in your Team Fortress 2 inventory') > -1) {
                                return callback(null, 'I don\'t have space for more items in my inventory');
                            } else if (err.eresult !== undefined) {
                                if (err.eresult == 10) {
                                    callback(null, 'An error occurred while sending your trade offer, this is most likely because I\'ve recently accepted a big offer');
                                } else if (err.eresult == 15) {
                                    callback(null, 'I don\'t, or you don\'t, have space for more items');
                                } else if (err.eresult == 16) {
                                    // This happens when Steam is already handling an offer (usually big offers), the offer should be made
                                    callback(null, 'An error occurred while sending your trade offer, this is most likely because I\'ve recently accepted a big offer');
                                } else if (err.eresult == 20) {
                                    callback(null, 'Team Fortress 2\'s item server may be down or Steam may be experiencing temporary connectivity issues');
                                } else {
                                    callback(null, 'An error occurred while sending the offer (' + TradeOfferManager.EResult[err.eresult] + ')');
                                }
                                return;
                            }
                        }

                        return callback(err);
                    });
                });
            });
        });
    });
};

/**
 * Figurates out what currencies the buyer needs to offer
 * @param {Object} buyerCurrencies
 * @param {Object} price
 * @param {*} buying
 * @param {*} useKeys
 * @return {Object} An object containing the picked currencies and the amount of change that the seller needs to provide
 */
function constructOffer (buyerCurrencies, price, buying, useKeys) {
    const keyPrice = prices.getKeyPrices()[buying ? 'buy' : 'sell'];

    const value = price.toValue(useKeys ? keyPrice : undefined);

    const currencyValues = {
        '5021;6': useKeys ? keyPrice.toValue() : -1,
        '5002;6': 9,
        '5001;6': 3,
        '5000;6': 1
    };

    const skus = Object.keys(currencyValues);

    let remaining = value;

    let hasReversed = false;
    let reverse = false;
    let index = 0;

    const pickedCurrencies = {};

    /* eslint-disable-next-line no-constant-condition */
    while (true) {
        const key = skus[index];
        // Start at highest currency and check if we should pick that

        // Amount to pick of the currency
        let amount = remaining / currencyValues[key];
        if (amount > buyerCurrencies[key]) {
            // We need more than we have, choose what we have
            amount = buyerCurrencies[key];
        }

        if (index === skus.length - 1) {
            // If we are at the end of the list and have a postive remaining amount,
            // then we need to loop the other way and pick the value that will make the remaining 0 or negative

            if (hasReversed) {
                // We hit the end the second time, break out of the loop
                break;
            }

            reverse = true;
        }

        const currAmount = pickedCurrencies[key] || 0;

        if (reverse && amount > 0) {
            // We are reversing the array and found an item that we need
            if (currAmount + Math.ceil(amount) > buyerCurrencies[key]) {
                // Amount is more than the limit, set amount to the limit
                amount = buyerCurrencies[key] - currAmount;
            } else {
                amount = Math.ceil(amount);
            }
        }

        if (amount >= 1 && pickedCurrencies[key] !== Math.floor(amount)) {
            // If the amount is greater than or equal to 1, then I need to pick it
            pickedCurrencies[key] = currAmount + Math.floor(amount);
            // Remove value from remaining
            remaining -= Math.floor(amount) * currencyValues[key];
        }

        if (remaining === 0) {
            // Picked the exact amount, stop
            break;
        }

        if (remaining < 0) {
            // We owe them money, break out of the loop
            break;
        }

        if (index === 0 && reverse) {
            // We were reversing and then reached start of the list, say that we have reversed and go back the other way
            hasReversed = true;
            reverse = false;
        }

        index += reverse ? -1 : 1;
    }

    if (remaining < 0) {
        // Removes unnessesary items
        for (let i = 0; i < skus.length; i++) {
            const sku = skus[i];

            let amount = Math.floor(Math.abs(remaining) / currencyValues[sku]);
            if (pickedCurrencies[sku] && pickedCurrencies[sku] < amount) {
                amount = pickedCurrencies[sku];
            }

            if (amount >= 1) {
                remaining += amount * currencyValues[sku];
                pickedCurrencies[sku] -= amount;

                if (pickedCurrencies[sku] === 0) {
                    delete pickedCurrencies[sku];
                }
            }
        }
    }

    return {
        currencies: pickedCurrencies,
        change: remaining
    };
}

exports.newOffer = function (offer, done) {
    offer.log('info', 'is being processed...');

    const keyPrices = prices.getKeyPrices();

    const items = {
        our: inventory.createDictionary(offer.itemsToGive),
        their: inventory.createDictionary(offer.itemsToReceive)
    };

    // Use itemsDiff variable for checking stock limits

    const exchange = {
        contains: { items: false, metal: false, keys: false },
        our: { value: 0, keys: 0, scrap: 0, contains: { items: false, metal: false, keys: false } },
        their: { value: 0, keys: 0, scrap: 0, contains: { items: false, metal: false, keys: false } }
    };

    const itemsDiff = {};
    const itemsDict = { our: {}, their: {} };

    const states = [false, true];

    for (let i = 0; i < states.length; i++) {
        const buying = states[i];
        const which = buying ? 'their' : 'our';

        for (const sku in items[which]) {
            if (!Object.prototype.hasOwnProperty.call(items[which], sku)) {
                continue;
            }

            if (sku === 'unknown') {
                // Offer contains an item that is not from TF2
                offer.log('contains items not from TF2, declining...');
                return done('decline', 'INVALID_ITEMS');
            }

            if (sku === '5000;6') {
                exchange.contains.metal = true;
                exchange[which].contains.metal = true;
            } else if (sku === '5001;6') {
                exchange.contains.metal = true;
                exchange[which].contains.metal = true;
            } else if (sku === '5002;6') {
                exchange.contains.metal = true;
                exchange[which].contains.metal = true;
            } else if (sku === '5021;6') {
                exchange.contains.keys = true;
                exchange[which].contains.keys = true;
            } else {
                exchange.contains.items = true;
                exchange[which].contains.items = true;
            }

            const amount = items[which][sku].length;

            itemsDiff[sku] = (itemsDiff[sku] || 0) + amount * (buying ? 1 : -1);
            itemsDict[which][sku] = amount;
        }
    }

    offer.data('diff', itemsDiff);
    offer.data('dict', itemsDict);

    // Check if the offer is from an admin
    if (isAdmin(offer.partner)) {
        offer.log('info', 'is from an admin, accepting. Summary:\n' + offer.summarize());
        done('accept', 'ADMIN');
        return;
    }

    if (offer.itemsToGive.length === 0 && ['donate', 'gift'].indexOf(offer.message.toLowerCase()) !== -1) {
        offer.log('info', 'is a gift offer, accepting. Summary:\n' + offer.summarize());
        done('accept', 'GIFT');
        return;
    } else if (offer.itemsToReceive.length === 0 || offer.itemsToGive.length === 0) {
        offer.log('info', 'is a gift offer, declining...');
        done('decline', 'GIFT');
        return;
    }

    for (let i = 0; i < states.length; i++) {
        const buying = states[i];
        const which = buying ? 'their' : 'our';
        const intentString = buying ? 'buy' : 'sell';

        for (const sku in items[which]) {
            if (!Object.prototype.hasOwnProperty.call(items[which], sku)) {
                continue;
            }

            const assetids = items[which][sku];
            const amount = assetids.length;

            if (sku === '5000;6') {
                exchange[which].value += amount;
                exchange[which].scrap += amount;
            } else if (sku === '5001;6') {
                const value = 3 * amount;
                exchange[which].value += value;
                exchange[which].scrap += value;
            } else if (sku === '5002;6') {
                const value = 9 * amount;
                exchange[which].value += value;
                exchange[which].scrap += value;
            } else {
                const match = prices.get(sku, true);

                // TODO: Go through all assetids and check if the item is being sold for a specific price

                if (match !== null) {
                    // Add value of items
                    exchange[which].value += match[intentString].toValue(keyPrices[intentString].metal) * amount;
                    exchange[which].scrap += Currencies.toScrap(match[intentString].metal) * amount;

                    if (sku !== '5021;6') {
                        exchange[which].keys += match[intentString].keys * amount;
                    }
                }

                if (sku === '5021;6') {
                    // Offer contains keys
                    if (match === null) {
                        // We are not trading keys, add value anyway
                        exchange[which].value += keyPrices[intentString].toValue() * amount;
                        exchange[which].keys += amount;
                    }
                } else if (match === null || match.intent === buying ? 1 : 0) {
                    // Offer contains an item that we are not trading
                    return done('decline', 'INVALID_ITEMS');
                } else {
                    // Check stock limits (not for keys)
                    const diff = itemsDiff[sku];
                    if (inventory.amountCanTrade(sku, buying) - diff < 0) {
                        // User is taking too many / offering too many
                        offer.log('info', 'is taking / offering too many, declining...');
                        return done('decline', 'OVERSTOCKED');
                    }
                }
            }
        }
    }

    offer.data('value', {
        our: {
            keys: exchange.our.keys,
            metal: Currencies.toRefined(exchange.our.scrap)
        },
        their: {
            keys: exchange.their.keys,
            metal: Currencies.toRefined(exchange.their.scrap)
        },
        rates: {
            buy: keyPrices.buy.metal,
            sell: keyPrices.sell.metal
        }
    });

    if (exchange.contains.metal && !exchange.contains.keys && !exchange.contains.items) {
        // Offer only contains metal
        offer.log('info', 'only contains metal, declining...');
        return done('decline', 'ONLY_METAL');
    } else if (exchange.contains.keys && !exchange.contains.items) {
        // Offer is for trading keys, check if we are trading them
        const priceEntry = prices.get('5021;6', true);
        if (priceEntry === null) {
            // We are not trading keys
            offer.log('info', 'we are not trading keys, declining...');
            return done('decline', 'NOT_TRADING_KEYS');
        } else if (exchange.our.contains.keys && (priceEntry.intent !== 1 && priceEntry.intent !== 2)) {
            // We are not selling keys
            offer.log('info', 'we are not selling keys, declining...');
            return done('decline', 'NOT_TRADING_KEYS');
        } else if (exchange.their.contains.keys && (priceEntry.intent !== 0 && priceEntry.intent !== 2)) {
            // We are not buying keys
            offer.log('info', 'we are not buying keys, declining...');
            return done('decline', 'NOT_TRADING_KEYS');
        } else {
            // Check overstock / understock on keys
            const diff = itemsDiff['5021;6'];
            // If the diff is greater than 0 then we are buying, less than is selling
            if (diff !== 0 && inventory.amountCanTrade('5021;6', diff > 0) - diff < 0) {
                // User is taking too many / offering too many
                offer.log('info', 'is taking / offering too many keys, declining...');
                return done('decline', 'OVERSTOCKED');
            }
        }
    }

    // Check if the value is correct

    if (exchange.our.value > exchange.their.value) {
        // We are offering more than them, decline the offer
        offer.log('info', 'is not offering enough, declining...');
        return done('decline', 'INVALID_VALUE');
    }

    // TODO: If we are receiving items, mark them as pending and use it to check overstock / understock for new offers

    offer.log('info', 'checking escrow...');

    checkEscrow(offer, function (err, hasEscrow) {
        if (err) {
            log.warn('Failed to check escrow', err);
            return done();
        }

        if (hasEscrow) {
            offer.log('info', 'would be held if accepted, declining...');
            return done('decline', 'ESCROW');
        }

        offer.log('info', 'checking bans...');

        checkBanned(offer.partner.getSteamID64(), function (err, isBanned) {
            if (err) {
                log.warn('Failed to check banned', err);
                return done();
            }

            if (isBanned) {
                offer.log('info', 'partner is banned in one or more communities, declining...');
                return done('decline', 'BANNED');
            }

            offer.log('trade', 'accepting. Summary:\n' + offer.summarize());

            return done('accept', 'VALID_OFFER');
        });
    });
};

// TODO: Add error handling
function checkEscrow (offer, callback) {
    if (process.env.ACCEPT_ESCROW === 'true') {
        return callback(null, false);
    }

    offer.getUserDetails(function (err, me, them) {
        if (err) {
            return callback(err);
        }

        return callback(null, them.escrowDays !== 0);
    });
}

exports.offerChanged = function (offer, oldState) {
    const handledByUs = offer.data('handledByUs') === true;

    if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
        // Offer is accepted

        // Smelt metal
        require('handler/crafting').keepMetalSupply();

        // Sort inventory
        require('app/crafting').sortInventory(3);

        // Update listings
        const diff = offer.data('diff') || {};

        for (const sku in diff) {
            if (!Object.prototype.hasOwnProperty.call(diff, sku)) {
                continue;
            }

            listings.checkBySKU(sku);
        }

        admin.message('Trade #' + offer.id + ' with ' + offer.partner.getSteamID64() + ' is accepted. Summary:\n' + offer.summarize());
    }

    if (handledByUs) {
        if (offer.isOurOffer) {
            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                offer.log('trade', 'has been accepted. Summary:\n' + offer.summarize());
            } else if (offer.state === TradeOfferManager.ETradeOfferState.Declined) {
                client.chatMessage(offer.partner, 'Ohh nooooes! The offer is no longer available. Reason: The offer has been declined.');
            } else if (offer.state === TradeOfferManager.ETradeOfferState.Canceled) {
                if (oldState === TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation) {
                    client.chatMessage(offer.partner, 'Ohh nooooes! The offer is no longer available. Reason: Failed to accept mobile confirmation.');
                } else {
                    client.chatMessage(offer.partner, 'Ohh nooooes! The offer is no longer available. Reason: The offer has been active for a while.');
                }
            }
        }

        if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
            client.chatMessage(offer.partner, 'Success! The offer went through successfully.');
        } else if (offer.state == TradeOfferManager.ETradeOfferState.InvalidItems) {
            client.chatMessage(offer.partner, 'Ohh nooooes! Your offer is no longer available. Reason: Items not available (traded away in a different trade).');
        }
    }
};
