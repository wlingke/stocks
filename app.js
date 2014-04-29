var MongoClient = require('mongodb').MongoClient
var request = require('request');
var argv = require('minimist')(process.argv);

//Constants
var PUT_TYPE = "puts";
var CALL_TYPE = "calls";
var SKEW_WORST_CASE = 2;
var SKEW_SOME = 1;
var SKEW_NONE = -1;

//node app.js AAPL 2014-14 --spreads=calls --skew=1 --col=blah
var symbol = argv._[2];
var date = argv._[3];
var spread_type = argv.spreads;
var skew_level = argv.skew || 0;
var collection_name = argv.col || symbol + date;

MongoClient.connect('mongodb://localhost:27017/stocks', function (err, db) {
    if (err) throw err;

    var collection = db.collection(collection_name);

    //From YQL console
    var url = "http://query.yahooapis.com/v1/public/yql?q=";
    var qs = "SELECT * FROM yahoo.finance.options WHERE symbol='" + symbol + "' AND expiration='" + date + "'";
    var options = "&format=json&diagnostics=false&env=store%3A%2F%2Fdatatables.org%2Falltableswithkeys&callback=";
    var request_url = url + encodeURIComponent(qs) + options;

    request(request_url, function (err, res, body) {
        var data, options, calls, puts, spreads = [];
        if (err) {
            throw err;
        }

        if (res.statusCode !== 200) {
            console.log("Status Code: " + res.statusCode)
            console.log(body);
            throw new Error();
        }

        data = JSON.parse(body);
        options = data.query.results.optionsChain.option;

        if (typeof options === "undefined") {
            throw "No option data. Check inputs";
        }

        function parseFloatWithDefault(str) {
            return parseFloat(str) || 0;
        }

        function estimatePrice(bid, ask, skew_towards) {
            var base = (bid + ask)/2;
            if (skew_level === SKEW_NONE) {
                return base
            }

            if (skew_towards === "bid") {
                if (skew_level === SKEW_WORST_CASE) {
                    base = bid;
                }else if(skew_level === SKEW_SOME){
                    base = base - (ask - bid)/4;
                }
                return Math.floor(base * 20) / 20;
            } else if (skew_towards === "ask") {
                if (skew_level === SKEW_WORST_CASE) {
                    base = ask;
                }else if (skew_level === SKEW_SOME){
                    base = base + (ask - bid)/4;
                }
                return Math.ceil(base * 20) / 20;
            }else {
                throw "skew_towards must be 'bid' or 'ask'";
            }
        }

        function generateDoc(long, short, type) {
            var doc = {
                symbol: symbol,
                expiration: date,
                type: type,
                created: new Date(),
                long_strike: parseFloatWithDefault(long.strikePrice),
                long_price: estimatePrice(parseFloatWithDefault(long.bid), parseFloatWithDefault(long.ask), "ask"),
                short_strike: parseFloatWithDefault(short.strikePrice),
                short_price: estimatePrice(parseFloatWithDefault(short.bid), parseFloatWithDefault(short.ask), "bid")
            };

            doc.spread_cost = doc.long_price - doc.short_price;
            doc.max_profit = Math.abs(doc.short_strike - doc.long_strike);
            doc.risk_reward = doc.max_profit / doc.spread_cost;

            return doc;
        }

        function calculateCallSpreads() {
            var long, short, documents = [];
            calls = options.filter(function (element) {
                return element.type === "C";
            });

            for (var i = 0, ii = calls.length; i < ii - 1; i++) {
                long = calls[i];
                for (var j = i + 1; j < ii; j++) {
                    short = calls[j];
                    documents.push(generateDoc(long, short, "C"));
                }
            }
            return documents;
        }

        function calculatePutSpreads() {
            var long, short, documents = [];
            puts = options.filter(function (element) {
                return element.type === "P"
            });
            for (var k = puts.length - 1; k > 0; k--) {
                long = puts[k];
                for (var l = k - 1; l > -1; l--) {
                    short = puts[l];
                    documents.push(generateDoc(long, short, "P"));
                }
            }
            return documents;
        }

        if (spread_type === PUT_TYPE) {
            spreads = calculatePutSpreads();
        } else if (spread_type === CALL_TYPE) {
            spreads = calculateCallSpreads();
        } else {
            spreads = calculateCallSpreads().concat(calculatePutSpreads());
        }

        if (spreads.length) {
            collection.drop(function (error, results) {
                collection.insert(spreads, function (e, d) {
                    if (e) throw e;
                    db.close()
                });
            });
        } else {
            db.close()
        }
    });


});
