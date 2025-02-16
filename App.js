const express = require('express');
const axios = require('axios');
const session = require('express-session');
const cors = require('cors');
require('dotenv').config();

const sessionOptions = {
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
};

if (process.env.NODE_ENV !== "development") {
  sessionOptions.proxy = true;
  sessionOptions.cookie = {
    sameSite: "none",
    secure: true,
  };
}

const app = express();
app.use(
    cors({
      credentials: true,
      origin: process.env.FRONTEND_URL,
    })
);
app.use(session(sessionOptions));
app.use(express.json());

const PORT = process.env.PORT || 4000;

// Sports Game Odds API
const ODDS_API_URL = 'https://api.sportsgameodds.com/v2/events';
const SPORTSBOOKS = {
  fanduel: 'FanDuel',
  fanatics: 'Fanatics',
  betmgm: 'BetMGM',
  fliff: 'Fliff',
  espnbet: 'ESPN Bet',
  caesars: 'Caesars',
  pinnacle: 'Pinnacle',
};

function convertAmericanOddsToDecimalOdds(americanOdds) {
  if (americanOdds < 0) {
    return -1 * (100 / americanOdds) + 1
  } else {
    return (americanOdds / 100) + 1
  }
}

function convertAmericanOddsToImpliedProbability(americanOdds) {
  if (americanOdds < 0) {
    return americanOdds / (americanOdds - 100)
  } else {
    return 100 / (americanOdds + 100)
  }
}

/**
 * Fetch odds from SportsGameOdds API
 * @param params
 * @returns {Promise<{}|null>}
 */
async function fetchOdds(params) {
  try {
    const response = await axios.get(
        `${ODDS_API_URL}`,
        {
          params: params,
          headers: {
            'x-api-key': process.env.ODDS_API_KEY,
          },
        });
    // const response = require('./example.json');
    return response.data.data;
  } catch (error) {
    console.error(error);
    return null;
  }
}

/**
 * Identifies Positive EV bets from the provided event
 * @param event A sports event, containing different bets
 * @returns {*[]} A list of bets with a positive EV
 */
function findPositiveEvBetsForEvent(event, minOdds, maxOdds, minEV) {
  if (!event || !event.odds) {
    return null;
  }
  const returnEventObject = {
    eventID: event.eventID,
    sportID: event.sportID,
    leagueID: event.leagueID,
    type: event.type,
    homeTeam: event.teams?.home?.names?.medium,
    awayTeam: event.teams?.away?.names?.medium,
    homeColor: event.teams?.home?.colors?.primary,
    awayColor: event.teams?.away?.colors?.primary,
    odds: {},
  };

  const odds = event.odds;

  const marketEntries = Object.entries(odds);
  marketEntries.forEach(([market, marketEntry]) => {
    const fairOdds = parseInt(marketEntry.fairOdds);
    const avgOdds = parseInt(marketEntry.bookOdds);
    if (!marketEntry.byBookmaker) {
      return;
    }
    const goodBookEntries = Object.entries(marketEntry.byBookmaker).filter(
        ([k, v]) => Object.keys(SPORTSBOOKS).includes(k) &&
            parseInt(v.odds) > fairOdds && parseInt(v.odds) <= maxOdds &&
            parseInt(v.odds) >= minOdds && v.overUnder === marketEntry.fairOverUnder);
    if (goodBookEntries.length > 0) {
      returnEventObject.odds[market] = {
        marketName: marketEntry.marketName,
        sideID: marketEntry.sideID,
        fairOdds: fairOdds,
        fairOverUnder: marketEntry.fairOverUnder,
        bookOdds: avgOdds,
        bookOverUnder: marketEntry.bookOverUnder,
        positiveEvBets: {},
      };

      goodBookEntries.forEach(([book, bookEntry]) => {
        const bookOdds = parseInt(bookEntry.odds);
        const ev = (convertAmericanOddsToImpliedProbability(fairOdds)
            * convertAmericanOddsToDecimalOdds(bookOdds)) - 1;
        if (ev > minEV) {
          returnEventObject.odds[market].positiveEvBets[book] = {
            name: SPORTSBOOKS[book],
            odds: bookOdds,
            overUnder: bookEntry.overUnder,
            ev,
          };
        }
      });

      if (Object.keys(returnEventObject.odds[market].positiveEvBets).length === 0) {
        delete returnEventObject.odds[market];
      }
    }
  });
  return returnEventObject;
}

/**
 * Identifies Positive EV bets from the provided event
 * @param event A sports event, containing different bets
 * @returns {*[]} A list of bets with a positive EV
 */
function findBetterBetsThanPinny(event, minOdds, maxOdds, minEV) {
  if (!event || !event.odds) {
    return null;
  }
  const returnEventObject = {
    eventID: event.eventID,
    sportID: event.sportID,
    leagueID: event.leagueID,
    type: event.type,
    homeTeam: event.teams?.home?.names?.medium,
    awayTeam: event.teams?.away?.names?.medium,
    homeColor: event.teams?.home?.colors?.primary,
    awayColor: event.teams?.away?.colors?.primary,
    odds: {},
  };

  const odds = event.odds;

  const marketEntries = Object.entries(odds);
  marketEntries.forEach(([market, marketEntry]) => {
    const fairOdds = parseInt(marketEntry.fairOdds);
    const avgOdds = parseInt(marketEntry.bookOdds);
    if (!marketEntry.byBookmaker || !Object.keys(
        marketEntry.byBookmaker).includes("pinnacle")) {
      return;
    }
    const pinnyOdds = parseInt(marketEntry.byBookmaker.pinnacle.odds);
    const pinnyOverUnder = parseInt(marketEntry.byBookmaker.pinnacle.overUnder);
    const goodBookEntries = Object.entries(marketEntry.byBookmaker).filter(
        ([k, v]) => Object.keys(SPORTSBOOKS).includes(k) &&
            parseInt(v.odds) > pinnyOdds && parseInt(v.odds) <= maxOdds &&
            parseInt(v.odds) >= minOdds && v.overUnder === pinnyOverUnder);
    if (goodBookEntries.length > 0) {
      returnEventObject.odds[market] = {
        marketName: marketEntry.marketName,
        sideID: marketEntry.sideID,
        fairOdds: fairOdds,
        fairOverUnder: marketEntry.fairOverUnder,
        bookOdds: avgOdds,
        bookOverUnder: marketEntry.bookOverUnder,
        pinnyOdds: pinnyOdds,
        pinnyOverUnder: pinnyOverUnder,
        positiveEvBets: {},
      };

      goodBookEntries.forEach(([book, bookEntry]) => {
        const bookOdds = parseInt(bookEntry.odds);
        const ev = (convertAmericanOddsToImpliedProbability(pinnyOdds)
            * convertAmericanOddsToDecimalOdds(bookOdds)) - 1;
        if (ev > minEV) {
          returnEventObject.odds[market].positiveEvBets[book] = {
            name: SPORTSBOOKS[book],
            odds: bookOdds,
            overUnder: bookEntry.overUnder,
            ev,
          };
        }
      });

      if (Object.keys(returnEventObject.odds[market].positiveEvBets).length === 0) {
        delete returnEventObject.odds[market];
      }
    }
  });
  return returnEventObject;
}

app.get('/odds', async (req, res) => {
  res.json(await fetchOdds({...req.query}));
});

app.get('/positive-ev-bets', async (req, res) => {
  const books = Object.keys(SPORTSBOOKS).reduce(
      (prev, curr, currIndex) => prev += ',' + curr);
  const minOdds = req.query.minOdds || -400;
  const maxOdds = req.query.maxOdds || 300;
  const minEV = req.query.minEV || 0;

  const events = await fetchOdds({
    limit: req.query.limit || 10,
    bookmakerID: books,
    leagueID: req.query.leagueID || "NBA",
    finalized: false,
    oddsAvailable: true,
    live: req.query.live,
  });

  if (!events) {
    res.status(404).send({error: "No events found for search criteria."});
    return;
  }

  const betsForEvents = events.map(
      event => findPositiveEvBetsForEvent(event, minOdds, maxOdds, minEV)).filter(
      event => Object.keys(event.odds).length > 0);
  res.json(betsForEvents);
});

app.get('/pinny-bets', async (req, res) => {
  const books = Object.keys(SPORTSBOOKS).reduce(
      (prev, curr, currIndex) => prev += ',' + curr);
  const minOdds = req.query.minOdds || -400;
  const maxOdds = req.query.maxOdds || 300;
  const minEV = req.query.minEV || 0;

  const events = await fetchOdds({
    limit: req.query.limit || 5,
    bookmakerID: books,
    leagueID: req.query.leagueID || "NBA",
    finalized: false,
    oddsAvailable: true,
    live: req.query.live,
  });

  if (!events) {
    res.status(404).send({error: "No events found for search criteria."});
    return;
  }

  const betsForEvents = events.map(
      event => findBetterBetsThanPinny(event, minOdds, maxOdds, minEV)).filter(
      event => Object.keys(event.odds).length > 0);
  res.json(betsForEvents);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
