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
const ODDS_API_URL = 'https://api.sportsgameodds.com/v2';
const SPORTSBOOKS = {
  fanduel: 'FanDuel',
  fanatics: 'Fanatics',
  betmgm: 'BetMGM',
  fliff: 'Fliff',
  espnbet: 'ESPN Bet',
  caesars: 'Caesars',
  pinnacle: 'Pinnacle',
};
const BOOKS_AS_COMMA_LIST = Object.keys(SPORTSBOOKS).join(',');

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

function determineBetSizeUsingKellyCriterion(bankroll, betOdds, trueOdds,
    kellyFraction = 0.25) {
  const p = convertAmericanOddsToImpliedProbability(trueOdds);
  const q = 1 - p;
  const b = convertAmericanOddsToDecimalOdds(betOdds) - 1;
  const kelly = (b * p - q) / b
  return kelly * kellyFraction * bankroll;
}

/**
 * Fetch odds from SportsGameOdds API
 * @param params
 * @returns {Promise<{}|null>}
 */
async function fetchOdds(params) {
  try {
    const response = await axios.get(
        `${ODDS_API_URL}/events`,
        {
          params: params,
          headers: {
            'x-api-key': process.env.ODDS_API_KEY,
          },
        });
    return response.data.data;
  } catch (error) {
    return null;
  }
}

async function fetchUsageLimits() {
  const response = await axios.get(
      `${ODDS_API_URL}/account/usage`, {
        headers: {
          'x-api-key': process.env.ODDS_API_KEY,
        },
      });
  return response.data.data;
}

/**
 * Identifies Positive EV bets from the provided event, compared to either
 * "fair" odds or Pinnacle odds.
 * @param event A sports event, containing different bets
 * @param minOdds The minimum odds for a bet to be considered
 * @param maxOdds The maximum odds for a bet to be considered
 * @param minEV The minimum EV for a bet to be considered
 * @param comparePinnacle Whether the bet odds should be compared to Pinnacle
 *                        vs. the "fair" odds.
 * @param bankroll The amount of bankroll the bettor has
 * @returns {*[]} A list of bets with a positive EV (based on the input values)
 */
function processEventBets(event, minOdds, maxOdds, minEV,
    comparePinnacle = false, bankroll = 1000) {
  if (!event?.odds) {
    return null;
  }

  const {eventID, sportID, leagueID, type, teams, odds} = event;
  const returnEventObject = {
    eventID: eventID,
    sportID: sportID,
    leagueID: leagueID,
    type: type,
    homeTeam: teams?.home?.names?.medium,
    awayTeam: teams?.away?.names?.medium,
    homeColor: teams?.home?.colors?.primary,
    awayColor: teams?.away?.colors?.primary,
    odds: {},
  };

  Object.entries(odds).forEach(([market, marketEntry]) => {
    const {
      fairOdds,
      bookOdds,
      byBookmaker,
      marketName,
      sideID,
      fairOverUnder,
      bookOverUnder
    } = marketEntry;
    if (!byBookmaker || (comparePinnacle && !byBookmaker.pinnacle)) {
      return;
    }

    const referenceOdds = comparePinnacle ? parseInt(byBookmaker.pinnacle.odds)
        : parseInt(fairOdds);
    const referenceOverUnder = comparePinnacle ? byBookmaker.pinnacle.overUnder
        : fairOverUnder;

    const goodBets = Object.entries(byBookmaker)
    .filter(
        ([book, entry]) => SPORTSBOOKS[book] && parseInt(entry.odds)
            > referenceOdds
            && parseInt(entry.odds) <= maxOdds && parseInt(entry.odds)
            >= minOdds && entry.overUnder === referenceOverUnder);

    if (goodBets.length) {
      returnEventObject.odds[market] = {
        marketName,
        sideID,
        fairOdds: parseInt(fairOdds),
        fairOverUnder,
        bookOdds: parseInt(bookOdds),
        bookOverUnder,
        positiveEvBets: {},
      };
      if (comparePinnacle) {
        returnEventObject.odds[market].pinnyOdds = referenceOdds;
        returnEventObject.odds[market].pinnyOverUnder = referenceOverUnder;
      }

      goodBets.forEach(([book, entry]) => {
        const bookOdds = parseInt(entry.odds);
        const ev = (convertAmericanOddsToImpliedProbability(referenceOdds)
            * convertAmericanOddsToDecimalOdds(bookOdds)) - 1;
        if (ev > minEV) {
          returnEventObject.odds[market].positiveEvBets[book] = {
            name: SPORTSBOOKS[book],
            odds: bookOdds,
            overUnder: entry.overUnder,
            ev,
            recommendedBetSize: determineBetSizeUsingKellyCriterion(
                bankroll, bookOdds, referenceOdds
            ),
          };
        }
      });

      if (!Object.keys(returnEventObject.odds[market].positiveEvBets).length) {
        delete returnEventObject.odds[market];
      }
    }
  });

  return returnEventObject;
}

app.get('/odds', async (req, res) => {
  res.json(await fetchOdds({...req.query}));
});

app.get('/good-bets', async (req, res) => {
  const {
    minOdds = '-400',
    maxOdds = '300',
    minEV = '0',
    limit = '1',
    leagueID = 'NBA',
    live = 'false',
    comparePinnacle = 'false',
    bankroll = '1000',
  } = req.query;

  const events = await fetchOdds({
    limit: parseInt(limit),
    bookmakerID: BOOKS_AS_COMMA_LIST,
    leagueID,
    finalized: false,
    oddsAvailable: true,
    live,
  });

  if (!events) {
    res.sendStatus(404);
    return;
  }

  const betsForEvents = events.map(
      event => processEventBets(event, parseInt(minOdds), parseInt(maxOdds),
          parseFloat(minEV), comparePinnacle === 'true',
          parseFloat(bankroll))).filter(
      event => Object.keys(event.odds).length > 0);
  res.json(betsForEvents);
});

app.get('/limits', async (req, res) => {
  const limits = await fetchUsageLimits();
  res.json(limits);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
