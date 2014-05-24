var HTTP = require('q-io/http');
var cheerio = require('cheerio');
var humanize = require('humanize');
var moment = require('moment-timezone');

var abbrHash = require('./abbrHash.json');

var bold = function(str) {
  return '\u0002' + str + '\u000F';
};

var int = function(str) {
  return parseInt(str, 10);
};

var toAbbr = function(team) {
  return Object.keys(abbrHash).filter(function(key) {
    return abbrHash[key].toLowerCase() === team.toLowerCase();
  })[0];
};

module.exports = {
  "mls": function(data, user, target) {
    var date, ds = data ? data.split(" ") : [];
    if(ds.length > 0) {
      // requested a date!
      date = ds[0];
      if(!date.match(/^[\d]{8}$/)) {
        this.client.say(target, "The date specified is incorrectly formatted. Your request should look like ,mls [YYYYMMDD]");
        return user.nickname + " asked for the MLS schedule for '" + data + "', but the date was badly formatted.";
      }
      date = moment(date, "YYYYMMDD");
    } else {
      date = moment();
    }
    var url = 'http://www.espnfc.com/scores/_/date/' + date.format('YYYYMMDD') + '/league/usa.1';
    HTTP.read(url).then(function(b) {
      var $ = cheerio.load(b.toString());

      var rows = $('.scores-top .teams');
      if(rows.length === 0) {
        return 'No games found.';
      }
      return Array.prototype.map.call(rows, function(row) {
        var dateStr = $(row.children[0]).text().trim();
        if(!dateStr.match(/(FT|HT)/)) {
          if(dateStr.split(', ').length === 1) {
            dateStr = moment().format('MMMM D') + ', ' + dateStr;
          }
          dateStr = moment(dateStr, 'MMMM D, HH:mm').tz('America/New_York').format('h:mm A') + ' ET';
        }
        var scores = $(row.children[2]).text().replace(/[^0-9\-]/g,'').split('-').map(int);
        if(scores.length > 1) {
          var tm1 = $(row.children[1]).text().trim() + ' ' + scores[0];
          var tm2 = $(row.children[3]).text().trim() + ' ' + scores[1];
          if(scores[0] < scores[1]) {
            tm2 = bold(tm2);
          } else if(scores[0] > scores[1]) {
            tm1 = bold(tm1);
          }
          return tm1 + ' ' + tm2 + ' (' + dateStr + ')';
        } else {
          return $(row.children[1]).text().trim() + ' vs ' + $(row.children[3]).text().trim() + ' (' + dateStr + ')';
        }
      }).join("\n");
    }).then(function(sched) {
      this.client.say(target, sched);
      return user.nickname + ' asked for the MLS schedule.';
    }.bind(this));
  },
  "nhl": function(data, user, target) {
    var date;
    if (data === 'tomorrow') {
      date = moment().tz('America/New_York').add(moment.duration(1, 'day'));
    } else {
      date = moment().tz('America/New_York');
    }
    HTTP.read('http://live.nhle.com/GameData/RegularSeasonScoreboardv3.jsonp').then(function(b) {
      var games = JSON.parse(b.toString('utf8').replace('loadScoreboard(','').slice(0,-1)).games;
      return games.filter(function(game) {
        var d = game.ts.split(' ').pop();
        if(d.toLowerCase() === 'today') {
          d = moment().tz('America/New_York');
        } else {
          d = moment(d, 'M/D', 'America/New_York');
        }
        return d.format('YYYYMMDD') === date.format('YYYYMMDD');
      }).map(function(game) {
        return toAbbr(game.atv) + " @ " + toAbbr(game.htv) + ' (' + game.bs + ' ET) [' + game.ustv.split(',').concat(game.catv.split(',')).join(', ') + ']';
      }).join("\n");
    }).then(function(sched) {
      this.client.say(target, sched);
      return user.nickname + ' asked for the NHL schedule.';
    }.bind(this));
  }
};