var HTTP = require('q-io/http');
var cheerio = require('cheerio');
var humanize = require('humanize');
var moment = require('moment-timezone');

var bold = function(str) {
  return '\u0002' + str + '\u000F';
};

var int = function(str) {
  return parseInt(str, 10);
};
var zipHash = function(keys, values) {
  var obj = {};
  keys.forEach(function(key, i) {
    obj[key] = values[i];
  });
  return obj;
};

var getDate = function(data) {
  var ds = data.split(' ');
  var data_date = ds.pop();
  if (data_date === 'tomorrow') {
    date = moment().tz('America/New_York').add(moment.duration(1, 'day'));
  } else if(data_date.match(/^[\d]{8}$/)) {
    date = moment(data_date, 'YYYYMMDD', 'America/New_York');
  } else {
    date = moment().tz('America/New_York');
  }
  return date;
};

var getNFLData = function(data) {
  var ds = (data === '') ? [] : data.split(' ');
  var numRegex = /^\d+$/, seasonRegex = /^(pre|reg)$/i;
  var weekNums = ds.filter(function(d) {
    return numRegex.test(d);
  });
  var seasonTypes = ds.filter(function(d) {
    return seasonRegex.test(d);
  });
  var otherWords = ds.filter(function(d) {
    return !seasonRegex.test(d) && !numRegex.test(d);
  });
  var week = (weekNums.length > 0) ? int(weekNums.pop()) : 1;
  var season = (seasonTypes.length > 0) ? seasonTypes.pop().toUpperCase() : 'PRE';
  var tm = (otherWords.length > 0) ? otherWords.pop() : null;
  return {
    query: 'week=' + week + '&seasonType=' + season,
    teamFilter: tm
  };
};

var filterTm = function(team) {
  var t = team.toLowerCase();
  return function(g) {
    return [g.h.toLowerCase(), g.v.toLowerCase()].indexOf(t) > -1;
  };
};

var removeEmpty = function(e) { return e && e !== ''; };

var baseballMap = function(showAll) {
  return function(g) {
    var tm1 = g.away_name_abbrev;
    var tm2 = g.home_name_abbrev;
    var inning, s1, s2;
    switch(g.status.status.toLowerCase()) {
      case 'final':
        if(!showAll) {
          return;
        }
        inning = "Final";
        s1 = int(g.linescore.r.away);
        s2 = int(g.linescore.r.home);
        tm1 += ' ' + s1;
        tm2 += ' ' + s2;
        if(s1 < s2) {
          tm2 = bold(tm2);
        } else if(s1 > s2) {
          tm1 = bold(tm1);
        }
        break;
      case 'in progress':
        inning = g.status.inning_state + " " + humanize.ordinal(g.status.inning);
        s1 = int(g.linescore.r.away);
        s2 = int(g.linescore.r.home);
        tm1 += ' ' + s1;
        tm2 += ' ' + s2;
        if(s1 < s2) {
          tm2 = bold(tm2);
        } else if(s1 > s2) {
          tm1 = bold(tm1);
        }
        break;
      default:
        if(!showAll) {
          return;
        }
        inning = [g.time, g.ampm, g.time_zone].join(' ');
        break;
    }
    return tm1 + ' @ ' + tm2 + " (" + inning + ")";
  };
};

var nflMap = function(game) {
  var date = moment(game.eid.toString(10).slice(0,-2) + ' ' + game.t + ' PM','YYYYMMDD h:mm A', 'America/New_York');
  var tm1 = game.v;
  var tm2 = game.h;
  var s1 = int(game.vs), s2 = int(game.hs);
  var dateStr = date.format('ddd hh:mm A');
  if(game.q !== 'P') {
    tm1 += ' ' + s1;
    tm2 += ' ' + s2;
    if(s1 < s2) {
      tm2 = bold(tm2);
    } else if(s1 > s2) {
      tm1 = bold(tm1);
    }
    if(game.q === 'F') {
      dateStr = 'Final';
    } else if(game.q === 'H') {
      dateStr = 'Half';
    } else {
      dateStr = humanize.ordinal(int(game.q));
    }
  }
  return tm1 + " @ " + tm2 + " (" + dateStr + ")";
};

module.exports = {
  "mls": function(data, user, target) {
    var date = getDate(data);
    var showAll = data.split(' ')[0] === '*';
    var url = 'http://www.espnfc.com/scores/_/date/' + date.format('YYYYMMDD') + '/league/usa.1';
    HTTP.read(url).then(function(b) {
      var $ = cheerio.load(b.toString());

      var rows = $('.scores-top .teams');
      if(rows.length === 0) {
        return 'No games found.';
      }
      return Array.prototype.map.call(rows, function(row) {
        var dateStr = $(row.children[0]).text().trim();
        if(!dateStr.match(/(FT|HT|[\d]+')/)) {
          if(dateStr.split(', ').length === 1) {
            dateStr = moment().format('MMMM D') + ', ' + dateStr;
          }
          dateStr = moment(dateStr, 'MMMM D, HH:mm').tz('America/New_York').format('h:mm A') + ' ET';
        }
        var scores = $(row.children[2]).text().replace(/[^0-9\-]/g,'').split('-').map(int);
        var tm1 = $(row.children[1]).text().trim(), tm2 = $(row.children[3]).text().trim();
        if(scores.length > 1) {
          tm1 += ' ' + scores[0];
          tm2 += ' ' + scores[1];
          if(scores[0] < scores[1]) {
            tm2 = bold(tm2);
          } else if(scores[0] > scores[1]) {
            tm1 = bold(tm1);
          }
          return tm1 + ' vs. ' + tm2 + ' (' + dateStr + ')';
        } else {
          return tm1 + ' vs. ' + tm2 + ' (' + dateStr + ')';
        }
      }).join("\n");
    }).then(function(sched) {
      this.client.say(target, sched);
      return user.nickname + ' asked for the MLS schedule.';
    }.bind(this));
  },
  "nhl": function(data, user, target) {
    var date = getDate(data);
    var showAll = data.split(' ')[0] === '*';
    var url = 'http://live.nhle.com/GameData/GCScoreboard/' + date.format('YYYY-MM-DD') + '.jsonp';
    HTTP.read(url).then(function(b) {
      var json = JSON.parse(b.toString('utf8').trim().match(/^loadScoreboard\((.+?)\)$/)[1]);
      var games = json.games;
      if(games.length === 0) {
        return 'No games found.';
      }
      return games.map(function(game) {
        var tm1 = game.ata, tm2 = game.hta;

        var time = game.bs + ' ET';
        if (['final', 'progress'].indexOf(game.bsc) > -1) {
          time = game.bs;
          var s1 = game.ats, s2 = game.hts;
          tm1 += ' ' + s1;
          tm2 += ' ' + s2;
          if(s1 < s2) {
            tm2 = bold(tm2);
          } else if(s1 > s2) {
            tm1 = bold(tm1);
          }
        }
        var stations = game.usnationalbroadcasts.split(', ').concat(game.canationalbroadcasts.split(', ')).join(', ');
        return tm1 + " @ " + tm2 + ' (' + time + ') [' + stations + ']';
      }).join("\n");
    }).then(function(sched) {
      this.client.say(target, sched);
      return user.nickname + ' asked for the NHL schedule.';
    }.bind(this)).done();
  },
  "nba": function(data, user, target) {
    var date = getDate(data);
    var showAll = data.split(' ')[0] === '*';
    HTTP.read('http://stats.nba.com/stats/scoreboard/?LeagueID=00&DayOffset=0&gameDate=' + date.format('MM/DD/YYYY') + '&' + new Date().getTime()).then(function(b) {
      var json = JSON.parse(b.toString('utf8'));
      // construct team id hash
      var teams = {};
      var lines = json.resultSets[1];
      lines.rowSet.forEach(function(row) {
        var hash = zipHash(lines.headers, row);
        teams[hash.TEAM_ID] = hash;
      });
      // actually load games
      var games = json.resultSets[0];
      if(games.rowSet.length === 0) {
        return 'No games found.';
      }
      return games.rowSet.map(function(row) {
        var hash = zipHash(games.headers, row);
        var homeTeam = teams[hash.HOME_TEAM_ID];
        var awayTeam = teams[hash.VISITOR_TEAM_ID];
        var futureTime = moment(hash.GAME_STATUS_TEXT, 'h:mm a \\E\\T', 'America/New_York', true);
        var dateStr, tm1 = awayTeam.TEAM_ABBREVIATION, tm2 = homeTeam.TEAM_ABBREVIATION;
        var qtrMatch = hash.GAME_STATUS_TEXT.match(/(Start|End) of (.+) Qtr/i);
        if(futureTime.isValid()) {
          dateStr = futureTime.format('h:mm A') + ' ET';
        } else {
          if(['final', 'halftime'].indexOf(hash.GAME_STATUS_TEXT.toLowerCase()) > -1) {
            dateStr = hash.GAME_STATUS_TEXT;
          } else if(qtrMatch) {
            dateStr = qtrMatch[0] + ' ' + qtrMatch[1];
          } else {
            dateStr = hash.LIVE_PC_TIME + ' ' + hash.GAME_STATUS_TEXT.split(' ')[0];
          }
          var s1 = awayTeam.PTS, s2 = homeTeam.PTS;
          tm1 += ' ' + s1;
          tm2 += ' ' + s2;
          if(s1 < s2) {
            tm2 = bold(tm2);
          } else if(s1 > s2) {
            tm1 = bold(tm1);
          }
        }
        return tm1 + " @ " + tm2 + ' (' + dateStr + ') [' + hash.NATL_TV_BROADCASTER_ABBREVIATION + ']';
      }).join("\n");
    }).then(function(sched) {
      this.client.say(target, sched);
      return user.nickname + ' asked for the NBA schedule.';
    }.bind(this));
  },
  "afl": function(data, user, target) {
    var url = "http://afl.com.au/api/cfs/afl/WMCTok";
    this.aflToken = "a85d68983510b6fefb856e2c6b9bcd74";
    return HTTP.read({
      url: url,
      method: "POST"
    }).then(function(b) {
      var json = JSON.parse(b.toString('utf8'));
      this.aflToken = json.token;
      return HTTP.read({
        url: "http://www.afl.com.au/api/cfs/afl/matchItems",
        headers: {
          "X-media-mis-token": json.token,
        "X-Requested-With":"XMLHttpRequest"
        }
      });
    }.bind(this), function(e) {
      if(!this.aflToken) {
        throw e;
      }
      return HTTP.read({
        url: "http://www.afl.com.au/api/cfs/afl/matchItems",
        headers: {
          "X-media-mis-token": this.aflToken,
          "X-Requested-With":"XMLHttpRequest"
        }
      });
    }.bind(this)).then(function(b) {
      var json = JSON.parse(b.toString('utf8'));
      return json.items.map(function(item) {
        var match = item.match, score = item.score;
        var tm1 = match.homeTeam.abbr;
        var tm2 = match.awayTeam.abbr;
        var date = moment(match.date).tz("America/New_York");
        var time = "";
        switch(match.status.toLowerCase()) {
          case "concluded":
            var total1 = score.homeTeamScore.matchScore.totalScore;
            var total2 = score.awayTeamScore.matchScore.totalScore;
            var s1 = [score.homeTeamScore.matchScore.goals,score.homeTeamScore.matchScore.behinds,score.homeTeamScore.matchScore.totalScore].join(".");
            var s2 = [score.awayTeamScore.matchScore.goals,score.awayTeamScore.matchScore.behinds,score.awayTeamScore.matchScore.totalScore].join(".");
            tm1 += " " + s1;
            tm2 += " " + s2;
            if(total1 < total2) {
              tm2 = bold(tm2);
            } else if(total1 > total2) {
              tm1 = bold(tm1);
            }
            time = "FINAL";
            break;
          case "scheduled":
            time = date.format("MM/DD hh:mm A") + " EST";
            break;
          default:
            return;
        }
        return tm1 + " vs. " + tm2 + " (" + time + ")";
      }).join("\n");
    }).then(function(sched) {
      this.client.say(target, sched);
      return user.nickname + ' asked for the AFL schedule.';
    }.bind(this));
  },
  "mlb": function(data, user, target) {
    var date = getDate(data);
    var showAll = data.split(' ')[0] === '*';
    var year = date.format('YYYY'), month = date.format('MM'), day = date.format('DD');
    var url = 'http://gd2.mlb.com/components/game/mlb/year_' + year + '/month_' + month + '/day_' + day + '/master_scoreboard.json';
    return HTTP.read(url).then(function(b) {
      var json = JSON.parse(b.toString('utf8'));
      var games = json.data.games;
      return games.game.map(baseballMap(showAll)).filter(removeEmpty).join(" | ");
    }).then(function(sched) {
      this.client.say(target, sched);
      return user.nickname + ' asked for the MLB schedule.';
    }.bind(this));
  },
  "mlbfull": function(data, user, target) {
    var date = getDate(data);
    var showAll = data.split(' ')[0] === '*';
    var year = date.format('YYYY'), month = date.format('MM'), day = date.format('DD');
    var url = 'http://gd2.mlb.com/components/game/mlb/year_' + year + '/month_' + month + '/day_' + day + '/master_scoreboard.json';
    return HTTP.read(url).then(function(b) {
      var json = JSON.parse(b.toString('utf8'));
      var games = json.data.games;
      return games.game.map(baseballMap).filter(removeEmpty).join("\n");
    }).then(function(sched) {
      this.client.say(target, sched);
      return user.nickname + ' asked for the MLB schedule.';
    }.bind(this));
  },
  "nfl": function(data, user, target) {
    var nflData = getNFLData(data);
    //var url = 'http://www.nfl.com/ajax/scorestrip?season=2014&' + nflData.query;
    var url = "http://www.nfl.com/liveupdate/scorestrip/ss.json?" + nflData.query;
    return HTTP.read(url + '&' + new Date().getTime()).then(function(b) {
      var json = JSON.parse(b.toString('utf8'));
      var games = json.gms;
      if(games.length === 0) {
        return 'No games found.';
      }
      var games2 = [];
      if(nflData.teamFilter) {
        games2 = games.filter(filterTm(nflData.teamFilter));
      }
      if(games2.length > 0) {
        games = games2;
      }
      return games.map(nflMap).join(" | ");
    }).then(function(sched) {
      this.client.say(target, sched);
      return user.nickname + ' asked for the NFL schedule.';
    }.bind(this));
  },
  "nflfull": function(data, user, target) {
    var nflData = getNFLData(data);
    //var url = 'http://www.nfl.com/ajax/scorestrip?season=2014&' + nflData.query;
    var url = "http://www.nfl.com/liveupdate/scorestrip/ss.json?" + nflData.query;
    return HTTP.read(url + '&' + new Date().getTime()).then(function(b) {
      var json = JSON.parse(b.toString('utf8'));
      var games = json.gms;
      if(games.length === 0) {
        return 'No games found.';
      }
      var games2 = [];
      if(nflData.teamFilter) {
        games2 = games.filter(filterTm(nflData.teamFilter));
      }
      if(games2.length > 0) {
        games = games2;
      }
      return games.map(nflMap).join("\n");
    }).then(function(sched) {
      this.client.say(target, sched);
      return user.nickname + ' asked for the NFL schedule.';
    }.bind(this));
  }
};