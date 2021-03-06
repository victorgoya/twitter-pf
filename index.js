require('dotenv').config();

const Twitter = require('twitter');
const puppeteer = require('puppeteer');
const tmp = require('tmp');

const bluebird = require("bluebird");
const redis = require("redis");
bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);

const store = redis.createClient({ url: process.env.REDIS_URL });

const client = new Twitter({
  consumer_key: process.env.TWITTER_CONSUMER_KEY,
  consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
  access_token_key: process.env.TWITTER_ACCESS_TOKEN,
  access_token_secret: process.env.TWITTER_SECRET_TOKEN
});

async function screenshotTweet(link, path) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.goto(link);
  await page.setViewport({ width: 1920, height: 1080 });

  const tweetElement = await page.$(".tweet");
  await tweetElement.screenshot({ path });

  await browser.close();
}

function status_includes(text, match_filters) {
  for (let match_filter of match_filters) {
    if (text.toLowerCase().includes(match_filter.toLowerCase())) {
      return (true);
    }
  }
  return (false);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    let temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
  return array;
}

let done = false;

(async () => {
  for (let search_query of shuffle(process.env.SEARCH_QUERY.split(","))) {
    const tweets = await client.get('search/tweets', { q: `"${search_query}"`, lang: process.env.SEARCH_LANGUAGE, result_type: "recent", count: 100 });

    for (status of tweets.statuses) {
      if (!status.in_reply_to_status_id_str && !status.in_reply_to_user_id_str && !status.retweeted_status &&
          status.text.length > parseInt(process.env.MIN_TEXT_LENGTH || 40) &&
          status_includes(status.text, process.env.MATCH_FILTER.split(",")) &&
          !(await store.getAsync(status.id_str))) {
        await store.setAsync(status.id_str, "x");
        tmp.dir(async function(err, dirPath) {
          const path = dirPath + "/screenshot.png";

          await new Promise(resolve => setTimeout(resolve, 5000));
          await screenshotTweet(`https://twitter.com/${status.user.screen_name}/status/${status.id_str}`, path);
          const mediaData = require('fs').readFileSync(path);

          const mediaRecord = await client.post('media/upload', { media: mediaData });
          await client.post('statuses/update', {
            status: `"${search_query}" par @${status.user.screen_name}`,
            media_ids: mediaRecord.media_id_string
          });
        });
        done = true;
        break;
      }
    }

    if (done) {
      break;
    }
  }
  store.quit();
})();
