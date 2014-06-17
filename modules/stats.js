 Q = require('q');
var FS = require('q-io/fs');
var HTTP = require('q-io/http');
var QSQL = require('q-sqlite3');
var cheerio = require('cheerio');
var humanize = require('humanize');
var moment = require('moment-timezone');
var fuzzy = require('fuzzy');

var getFullPlayerName = function(data) {
  var oneName = data.length === 1 && data[0].toLowerCase();
  return HTTP.read('http://www.hockey-reference.com/player_search.cgi?search=' + data.join('+')).then(function(b) {
    var $ = cheerio.load(b.toString());
    var results = [];
    $('#page_content table tr').map(function() {
      // convert everything to text since we don't care about the links
      var result = $(this).children('td').map(function() {
        return $(this).text();
      });
      // tack on the url so we have access to it later
      result[4] = "http://www.hockey-reference.com" + $(this).html().match(/href=\"(.+?)\"/)[1];
      return result;
    }).each(function() {
      var years = this[2].split('-').map(function(y){ return parseInt(y, 10); });
      if(years.length < 2) {
        return;
      }
      // pushes an array to results of the following:
      // [name, last active year, total years in league, url]
      results.push([this[0], years[1], years[1] - years[0], this[4]]);
    });
    if (results.length === 0) {
      // didn't find anyone!
      throw new Error('no player found');
    }
    // we sort in three stages:
    // first, if only one word was provided as data, we assume we're looking for
    // a last name, so results where the last name is the same have priority.
    // then we rank by most recent active year, then by years in the league.
    results = results.sort(function(a, b) {
      var lln = a[0].split(' ')[1].toLowerCase() === oneName;
      var rln = b[0].split(' ')[1].toLowerCase() === oneName;
      var curValue = (function() {
        if(oneName) {
          if(lln && !rln) {
            return -1;
          } else if(rln && !lln) {
            return 1;
          } else {
            return 0;
          }
        }
        return 0;
      })();
      if(!curValue) {
        curValue = b[1] - a[1];
      }
      if(!curValue) {
        curValue = b[2] - a[2];
      }
      return curValue;
    });
    // take the first result, return its url
    return results[0][3];
  }, function(e) {
    if(e.response.status === 302) {
      // if we got a failure with a 302, that means the data we sent redirected,
      // so we know the url we want. send that through.
      return e.response.headers.location;
    } else {
      // if it was some other error, throw an error to be dealt with down the line.
      throw e;
    }
  }).then(function(url) {
    // parse the ID out
    var id = url.match(/\/[a-z]\/(.+?)\.html$/)[1];
    return HTTP.read("http://www.hockey-reference.com/players/" + id[0] + "/" + id + ".html");
  }).then(function(b) {
    var $ = cheerio.load(b.toString());
    return $('span[itemprop=name]').text();
  });
};

var getPlayerIds = function(name) {
  var yahoo = HTTP.read('http://sports.yahoo.com/nhl/players?type=lastname&first=1&query=' + name.replace(' ', '+')).then(function(b) {
    var $ = cheerio.load(b.toString());
    return $('a[href^="/nhl/players/"]')[0].attribs.href.replace('/nhl/players/','');
  });
  var extraSkater = HTTP.read('http://www.extraskater.com/search?type=player&query=' + name.replace(' ', '+')).then(function(b) {
    // didn't redirect, so guy doesn't exist!
    return null;
  }, function(e) {
    if(e.response.status === 302) {
      return e.response.headers.location.replace('http://www.extraskater.com/player/', '');
    } else {
    // if it was some other error, throw an error to be dealt with down the line.
    throw e;
  }
  });
  var capGeek = HTTP.read('http://capgeek.com/search/?search_criteria=' + name.replace(' ', '+')).then(function(b) {
    // didn't redirect, so guy doesn't exist!
    return null;
  }, function(e) {
    if(e.response.status === 302) {
      return e.response.headers.location.replace('/player/', '');
    } else {
    // if it was some other error, throw an error to be dealt with down the line.
    throw e;
    }
  });
  var lastfirst = name.split(' ').reverse().join(', ');
  var rotoworld = HTTP.read('http://www.rotoworld.com/content/playersearch.aspx?searchname=' + lastfirst.replace(' ', '+') + '&sport=nhl').then(function(b) {
    // didn't redirect, so guy doesn't exist!
    return null;
  }, function(e) {
    if(e.response.status === 302) {
      return e.response.headers.location.replace('/player/nhl/', '');
    } else {
    // if it was some other error, throw an error to be dealt with down the line.
    throw e;
    }
  });
  return Q.all([yahoo, extraSkater, capGeek, rotoworld]).spread(function(y, es, cg, roto) {
    return JSON.stringify({
      yahoo: y,
      extraSkater: es,
      capGeek: cg,
      rotoworld: roto
    });
  });
};

var getPlayerData = function(db, data) {
  return QSQL.get(db, 'SELECT data, players.id AS pid FROM player_search JOIN players ON player_search.players_id = players.id WHERE query = ?', data).then(function(row) {
    if(row) {
      return { "data": JSON.parse(row.data), "pid": row.pid };
    }
    throw new Error('Not in database');
  }).fail(function() {
    return getFullPlayerName(data.split(" ")).then(getPlayerIds).then(function(ids) {
      return QSQL.run(db, 'INSERT INTO players (data) VALUES (?)', ids).then(function(statement) {
        var pid = statement.lastID;
        return QSQL.run(db, 'INSERT INTO player_search (query, players_id) VALUES (?, ?)', [data, pid]).then(function() {
          return { "data": JSON.parse(ids), "pid": pid };
        });
      });
    });
  });
};

var KEYS = {
  yahoo: ["gp", "g", "a", "p", "pm", "pim", "hit", "blk", "fw", "fl", null, "ppg", "ppa", "shg", "sha", "gwg", "sog", null],
  yahooG: ["gp", "gs", "min", "w", "l", "otl", "ega", "ga", "gaa", "sa", "sv", null, "so"],
  es: ["gp", "toi", null, null, "gfp", "gfp_rel", null, null, "cfp", "cfp_rel", null, null, "ffp", "ffp_rel", null, null, "sfp", "sfp_rel", "shp", "svp", "pdo"],
  esSummary: ["toi", "gf", "ga", "cf", "ca", null, "ff", "fa", null, "sf", "sa", null, null, null]
};

var getRotoworldNews = function(db, pid, ids) {
  return HTTP.read('http://www.rotoworld.com/recent/nhl/' + ids.rotoworld).then(function(b) {
    var $ = cheerio.load(b.toString());
    var stories = Array.prototype.slice.call($('.RW_playernews .pb'), 0, 3);
    return stories.map(function(story) {
      var $story = $(story);
      var dateStr = $story.find('.date').text().trim();
      var date = moment(dateStr, 'ddd, MMM D, YYYY hh:mm:ss A');
      if(!date.isValid()) {
        date = moment(dateStr, 'MMM D h:mm A');
      }
      return {
        date: date,
        story: $story.find('.report').text().trim(),
        source: $story.find('.source a').text().trim()
      };
    });
  }, function(e) {
    throw new Error('notfound');
  });
};

var getCapInfo = function(db, pid, ids) {
  return QSQL.get(db, 'SELECT data, players_id AS pid FROM stats_cap WHERE web_id = ?', ids.capGeek).then(function(row) {
    if(row) {
      return { "data": JSON.parse(row.data), "pid": row.pid, "web_id": ids.capGeek };
    }
    throw new Error('Not in database');
  }).fail(function() {
    return HTTP.read('http://capgeek.com/player/' + ids.capGeek).then(function(b) {
      var $ = cheerio.load(b.toString());
      var result = { contracts: []};
      var rows = $('#contractchart tbody tr:not(.column-head)');
      var inSection = false;
      Array.prototype.forEach.call(rows, function(row) {
        var $row = $(row);
        if($row.children('.section').length > 0) {
          inSection = false;
          var contractData = $row.find('span')[0].children.map(function(el) { return $(el).text().trim(); });
          var years = contractData[1].match(/(\d+) YEAR\(S\)/);
          if(!years) {
            // historical data, so discard
            return;
          }
          result.contracts.push({
            len: years[1] * 1,
            value: parseInt(contractData[3].replace(/[\$,]/g, ''), 10) / 1000000,
            type: contractData[5] === 'ENTRY LEVEL' ? 'el' : 's',
            expiry: contractData[7],
            source: contractData[9],
            seasons: {}
          });
          inSection = true;
          return;
        }
        if(!inSection) {
          return;
        }
        var cells = Array.prototype.map.call($row.children('td'), function(el) { return $(el).text().trim(); });
        if(cells.length > 1) {
          result.contracts[result.contracts.length - 1].seasons[cells[0]] = {
            aav: parseInt(cells.pop().replace(/[\$,]/g, ''), 10) / 1000000,
            hit: parseInt(cells.pop().replace(/[\$,]/g, ''), 10) / 1000000
          };
        } else {
          result.contracts[result.contracts.length - 1].clauses = cells[0].replace('CLAUSES: ', '');
        }
      });
      return result;
    }).then(function(json) {
      if(JSON.stringify(json) === '{}') {
        return { "data": {}, "pid": pid };
      }
      return QSQL.run(db, 'INSERT INTO stats_cap (data, players_id, web_id) VALUES (?, ?, ?)', [JSON.stringify(json), pid, ids.capGeek]).then(function() {
        return { "data": json, "pid": pid, "web_id": ids.capGeek };
      });
    });
  });
};

var getExtraSkaterStats = function(db, pid, ids) {
  return QSQL.get(db, 'SELECT data, players_id AS pid FROM stats_es_reg WHERE web_id = ?', ids.extraSkater).then(function(row) {
    if(row) {
      return { "data": JSON.parse(row.data), "pid": row.pid };
    }
    throw new Error('Not in database');
  }).fail(function() {
    return HTTP.read('http://www.extraskater.com/player/' + ids.extraSkater).then(function(b) {
      var $ = cheerio.load(b.toString());
      var result = {};
      var rows = $('#dashboard').parent().next().find('tbody tr:not(.playoff-season-row-dashboard)');
      rows.each(function() {
        var season = $($(this).children('td')[0]).text().replace('-20','-');
        var json = {};
        $(this).children('td.number-right').each(function(i) {
          if(KEYS.es[i]) {
            json[KEYS.es[i]] = $(this).text().trim();
          }
        });
        result[season] = json;
      });
      return result;
    }).then(function(json) {
      if(JSON.stringify(json) === '{}') {
        return { "data": {}, "pid": pid };
      }
      return QSQL.run(db, 'INSERT INTO stats_es_reg (data, players_id, web_id) VALUES (?, ?, ?)', [JSON.stringify(json), pid, ids.extraSkater]).then(function() {
        return { "data": json, "pid": pid };
      });
    });
  });
};

var yahooRegularHeaders = ["height", "weight", "shoots", "birthday", "birthplace", "draft"];
var yahooRegularHeadersG = ["height", "weight", "catches", "birthday", "birthplace", "draft"];

var getYahooRegularStats = function(db, pid, ids) {
  return QSQL.get(db, 'SELECT data, players_id AS pid FROM stats_yahoo_reg WHERE web_id = ?', ids.yahoo).then(function(row) {
    if(row) {
      return { "data": JSON.parse(row.data), "pid": row.pid };
    }
    throw new Error('Not in database');
  }).fail(function() {
    return HTTP.read('http://sports.yahoo.com/nhl/players/' + ids.yahoo + '/').then(function(b) {
      var $ = cheerio.load(b.toString());
      var result = {
        profile: {},
        seasons: {}
      };
      // load team info
      var playerInfo = $('div.player-info');
      result.profile.name = playerInfo.children('h1').text();
      var teamInfo = playerInfo.children('.team-info').text().replace(';','').split(',').map(function(t) { return t.replace(/^\s+|\s+$/g, '');});
      result.profile.number = teamInfo[0];
      result.profile.position = teamInfo[1];
      result.profile.team = teamInfo[2];

      var isGoalie = result.profile.position === 'G';
      var chosenKeys = (isGoalie) ? KEYS.yahooG : KEYS.yahoo;
      var chosenHeaders = (isGoalie) ? yahooRegularHeadersG : yahooRegularHeaders;

      // load profile
      Array.prototype.forEach.call($('div.bio dl'), function(el, i) {
        result.profile[chosenHeaders[i]] = $($(el).children('dd')[0]).text();
      });
      var preg = result.profile.draft.match(/^(\d{4})[^\d]+(\d+)[^\d]+round \((\d+)[^\d]+pick\) by the (.+?)$/);
      if(!preg) {
        // undrafted!
        result.profile.draft = null;
      } else {
        result.profile.draft = {
          year: preg[1],
          round: preg[2],
          overall: preg[3],
          team: preg[4]
        };
      }
      // load stats
      Array.prototype.forEach.call($('#mediasportsplayercareerstats tbody tr'), function(el) {
        // don't care about totals
        if(!$(el).children('th').hasClass('season')) {
          return;
        }
        var season = $(el).children('th').text();
        var json = {
          team: $(el).children('td.team').text()
        };
        Array.prototype.forEach.call($(el).children('td:not(.team)'), function(el, i) {
          if(chosenKeys[i]) {
            json[chosenKeys[i]] = $(el).text();
          }
        });
        result.seasons[season] = json;
      });
      return result;
    }).then(function(json) {
      return QSQL.run(db, 'INSERT INTO stats_yahoo_reg (data, players_id, web_id) VALUES (?, ?, ?)', [JSON.stringify(json), pid, ids.yahoo]).then(function() {
        return { "data": json, "pid": pid };
      });
    });
  });
};

var toPercent = function(number) {
  number *= 1000;
  number |= 0;
  return (number === 1000) ? '1.000' : '0.' + number;
};

var formatDraft = function(draft) {
  if(!draft) {
    return 'Undrafted';
  }
  return 'Drafted ' + draft.year + ' by the ' + draft.team + ', ' + humanize.ordinal(draft.round) + ' round (' + humanize.ordinal(draft.overall) + ' pick)';
};

var abbrHash = require('./abbrHash.json');

var reverseAbbr = function(teamName) {
  return Object.keys(abbrHash).filter(function(key) {
    return abbrHash[key] == teamName;
  })[0];
};

var bold = function(str) {
  return '\u0002' + str + '\u000F';
};

var int = function(num) { return parseInt(num, 10); };

var objToQuery = function(o) {
  var s = [];
  Object.keys(o).forEach(function(k) {
    s.push(k + "=" + o[k]);
  });
  return s.join("&");
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
  var data_date = ds[0];
  if (data_date === 'tomorrow') {
    date = moment().tz('America/New_York').add(moment.duration(1, 'day'));
  } else if(data_date.match(/^[\d]{8}$/)) {
    date = moment(data_date, 'YYYYMMDD', 'America/New_York');
  } else {
    date = moment().tz('America/New_York');
  }
  return date;
};

module.exports = {
  "nhlnews": function(data, user, target) {
    var searchQuery = data.toLowerCase();
    var db = this.db;
    return getPlayerData(db, searchQuery).then(function(data) {
      return getRotoworldNews(db, data.pid, data.data);
    }).then(function(stories) {
      var result = stories.map(function(story) {
        var str = bold('[' + story.date.format("MMMM D, YYYY") + ']') + ' ' + story.story;
        if(story.source) {
          str += ' (via ' + story.source + ')';
        }
        return str;
      });
      this.client.say(target, result.join("\n"));
    }.bind(this), function(e) {
      if(e.message === 'notfound') {
        this.client.say(target, 'Player news not found.');
      } else {
        throw e;
      }
    }.bind(this));
  },
  "cap": function(data, user, target) {
    var searchQuery = data.toLowerCase();
    var db = this.db;
    return getPlayerData(db, searchQuery).then(function(data) {
      return Q.all([getYahooRegularStats(db, data.pid, data.data), getCapInfo(db, data.pid, data.data)]);
    }).spread(function(yahoo, cg) {
      var cgId = cg.web_id;
      yahoo = yahoo.data;
      cg = cg.data;
      var profile = yahoo.profile;
      var curSeason = Object.keys(yahoo.seasons).pop();
      var curContract = cg.contracts.filter(function(contract) { return Object.keys(contract.seasons).indexOf(curSeason) > -1; })[0];
      var seasons = Object.keys(curContract.seasons);
      if(!curContract) {
        return;
      }
      var firstLine = [
        profile.name + ' [' + profile.team + '] ' + curSeason,
        'Cap Hit: $' + curContract.seasons[curSeason].hit + 'M ($' + curContract.seasons[curSeason].aav + 'M AAV)',
        'Contract: $' + curContract.value + 'M / ' + curContract.len + ' year' + (curContract.len !== 1 ? 's' : '') + ' (' + seasons.shift() + ' to ' + seasons.pop() + ')',
        'http://www.capgeek.com/player/' + cgId
      ];

      var secondLine = [
        'Expire Status: ' + curContract.expiry,
        'Clauses: ' + curContract.clauses || 'None'
      ];

      this.client.say(target, firstLine.join(' | ') + "\n" + secondLine.join(' | '));
      return user.nickname + ' asked for the cap info for ' + profile.name;
    }.bind(this)).fail(function(e) {
      if (e.message === "no player found") {
        this.client.say(target, "Sorry, no player was found with that query. Make sure you spelled everything right!");
      } else {
        this.client.say(target, "Sorry, there was an error processing your request. It's possible Yahoo!'s or CapGeek's stats page is broken.");
        this.logError(e.message);
      }
    }.bind(this));
  },
  "astats": function(data, user, target) {
    var searchQuery = data.toLowerCase();
    var db = this.db;
    return getPlayerData(db, searchQuery).then(function(data) {
      return Q.all([getYahooRegularStats(db, data.pid, data.data), getExtraSkaterStats(db, data.pid, data.data)]);
    }).spread(function(yahoo, es) {
      yahoo = yahoo.data;
      es = es.data;
      var curSeason = Object.keys(yahoo.seasons).pop();
      var profile = yahoo.profile;
      var stats = es[curSeason];

      var profileLine = [
        profile.name,
        profile.team + " " + profile.position + " " + profile.number,
        profile.height.replace('-', "'") + '" ' + profile.weight + 'lbs',
        formatDraft(profile.draft),
        'Born on ' + profile.birthday + ' in ' + profile.birthplace
      ];

      var statsLine = [
        'GP ' + stats.gp,
        'TOI ' + stats.toi,
        'GF% ' + stats.gfp,
        'GF% rel ' + stats.gfp_rel,
        'CF% ' + stats.cfp,
        'CF% rel ' + stats.cfp_rel,
        'FF% ' + stats.ffp,
        'FF% rel ' + stats.ffp_rel,
        'SF% ' + stats.sfp,
        'SF% rel ' + stats.sfp_rel,
        'Sh% ' + stats.shp,
        'Sv% ' + stats.svp,
        'PDO ' + stats.pdo
      ];

      this.client.say(target, profileLine.join(' | ') + "\n" + statsLine.join(' | '));
      return user.nickname + ' asked for the regular season fancy stats for ' + profile.name;
    }.bind(this)).fail(function(e) {
      if (e.message === "no player found") {
        this.client.say(target, "Sorry, no player was found with that query. Make sure you spelled everything right!");
      } else {
        this.client.say(target, "Sorry, there was an error processing your request. It's possible Yahoo!'s or Extra Skater's stats page is broken.");
        this.logError(e.message);
      }
    }.bind(this));
  },
  "stats": function(data, user, target) {
    var searchQuery = data.toLowerCase();
    var db = this.db;
    return getPlayerData(db, searchQuery).then(function(data) {
      return getYahooRegularStats(db, data.pid, data.data);
    }).then(function(data) {
      var json = data.data;
      var curSeason = Object.keys(json.seasons).pop();
      var profile = json.profile;
      var stats = json.seasons[curSeason];

      var profileLine = [
        profile.name,
        profile.team + " " + profile.position + " " + profile.number,
        profile.height.replace('-', "'") + '" ' + profile.weight + 'lbs',
        formatDraft(profile.draft),
        'Born on ' + profile.birthday + ' in ' + profile.birthplace
      ];
      var statsLine;
      if(profile.position !== 'G') {
        var faceoffs = (parseInt(stats.fw, 10) / (parseInt(stats.fw, 10) + parseInt(stats.fl, 10))) * 1000;
        faceoffs |= 0;
        statsLine = [
          curSeason,
          stats.team.toUpperCase(),
          'GP ' + stats.gp,
          'G ' + stats.g,
          'A ' + stats.a,
          'P ' + stats.p,
          '+/- ' + stats.pm,
          'PIM ' + stats.pim,
          'HITS ' + stats.hit,
          'BLKS ' + stats.blk,
          'FW ' + stats.fw,
          'FL ' + stats.fl,
          'FO% ' + toPercent(parseInt(stats.fw, 10) / (parseInt(stats.fw, 10) + parseInt(stats.fl, 10))),
          'PPG ' + stats.ppg,
          'PPA ' + stats.ppa,
          'SHG ' + stats.shg,
          'SHA ' + stats.sha,
          'GWG ' + stats.gwg,
          'SOG ' + stats.sog,
          'PCT ' + toPercent(parseInt(stats.g, 10) / (parseInt(stats.sog, 10)))
        ];
      } else {
        statsLine = [
          curSeason,
          stats.team.toUpperCase(),
          'GP ' + stats.gp,
          'GS ' + stats.gs,
          'MIN ' + stats.min,
          'W ' + stats.w,
          'L ' + stats.l,
          'OTL ' + stats.otl,
          'GA ' + stats.ga,
          'GAA ' + stats.gaa,
          'SA ' + stats.sa,
          'SV ' + stats.sv,
          'SV% ' + toPercent(parseInt(stats.sv, 10) / (parseInt(stats.sa, 10))),
          'SO ' + stats.so
        ];
      }

      this.client.say(target, profileLine.join(' | ') + "\n" + statsLine.join(' | '));
      return user.nickname + ' asked for the regular season stats for ' + profile.name;
    }.bind(this), function(e) {
      if (e.message === "no player found") {
        this.client.say(target, "Sorry, no player was found with that query. Make sure you spelled everything right!");
      } else {
        this.client.say(target, "Sorry, there was an error processing your request. It's possible Yahoo!'s stats page is broken.");
        this.logError(e.message);
      }
    }.bind(this));
  },
  "summary": function(data, user, target) {
    var ds = data.split(" "), date = getDate(data), page, teamAbbr;
    if(data.split(" ").length > 1) {
      teamAbbr = ds[1].toUpperCase();
    } else {
      teamAbbr = data.toUpperCase();
    }
    HTTP.read('http://www.nhl.com/ice/ajax/GCScoreboardJS?today=' + date.format('MM/DD/YYYY')).then(function(b) {
      var json = JSON.parse(b.toString('utf8').trim().match(/^loadScoreboard\((.+?)\)$/)[1]);
      var chosenGame = json.games.filter(function(game) {
        return game.ata === teamAbbr || game.hta === teamAbbr;
      }).shift();
      if(!chosenGame) {
        throw new Error('notfound');
      } else {
        var seasonYear = +chosenGame.id.toString().slice(0,4);
        var season = seasonYear + '' + (seasonYear + 1);
        return HTTP.read('http://live.nhl.com/GameData/' + season + '/' + chosenGame.id + '/PlayByPlay.json').then(function(b) {
          return [chosenGame, JSON.parse(b.toString('utf8').trim())];
        });
      }
    }).spread(function(game, playbyplay) {
      var plays = playbyplay.data.game.plays.play;
      var hits = [0, 0];
      plays.filter(function(play) {
        return play.type === 'Hit';
      }).forEach(function(hit) {
        var isHome = hit.hoi.indexOf(hit.pid1) > -1;
        if(isHome) {
          hits[1]++;
        } else {
          hits[0]++;
        }
      });
      var goals = plays.filter(function(play) {
        return play.type === 'Goal';
      }).map(function(goal) {
        var assists = [], ps, pts;
        var isHome = goal.hoi.indexOf(goal.pid1) > -1;
        var team = (isHome) ? game.hta : game.ata;
        var numH = goal.hoi.length, numA = goal.aoi.length;
        var special = '', homePP = numH > numA && numH < 7, awayPP = numH < numA && numA < 7;
        if(numH !== numA) {
          if(homePP) {
            special = (isHome) ? ' PP' : ' SH';
          } else if(awayPP) {
            special = (isHome) ? ' SH' : ' PP';
          }
        }
        ps = goal.p1name.split(" ");
        pts = goal.desc.match(new RegExp(goal.p1name + " \\((\\d+)\\)"))[1];
        var s = bold(team + " " + ps[0][0] + ". " + ps.slice(1).join(" ") + ' (' + pts + ')' + special);
        if(goal.p2name) {
          ps = goal.p2name.split(" ");
          pts = goal.desc.match(new RegExp(goal.p2name + " \\((\\d+)\\)"))[1];
          assists.push(ps[0][0] + ". " + ps.slice(1).join(" "));
        }
        if(goal.p3name) {
          ps = goal.p3name.split(" ");
          pts = goal.desc.match(new RegExp(goal.p3name + " \\((\\d+)\\)"))[1];
          assists.push(ps[0][0] + ". " + ps.slice(1).join(" "));
        }
        if(assists.length > 0) {
          s += " (" + assists.join(", ") + ")";
        }
        return s;
      });
      var s1 = game.ats, s2 = game.hts;
      var tm1 = game.ata + ' ' + s1;
      var tm2 = game.hta + ' ' + s2;
      if(s1 < s2) {
        tm2 = bold(tm2);
      } else if(s1 > s2) {
        tm1 = bold(tm1);
      }
      var line = [
        tm1 + " " + tm2 + " (" + game.bs + ")",
        "SOG " + game.atsog + "-" + game.htsog,
        "Hits " + hits.join('-'),
        "Goals: " + goals.join(", ")
      ];
      this.client.say(target, line.join(" | "));
    }.bind(this)).fail(function(e) {
      if(e.message === 'notfound') {
        this.client.say(target, "No game found.");
        return user.nickname + " asked for the game summary for '" + data + "', but that was not found.";
      }
       else { console.log(e); }
    }.bind(this));
  },
  "asummary": function(data, user, target) {
    var ds = data.split(" "), date, page, teamAbbr;
    if(data.split(" ").length > 1) {
      // requested a date!
      date = ds[0];
      teamAbbr = ds[1].toUpperCase();
      if(!date.match(/^[\d]{8}$/)) {
        this.client.say(target, "The date specified is incorrectly formatted. Your request should look like ,asummary [YYYYMMDD] abr");
        return user.nickname + " asked for the fancy game summary for '" + data + "', but the date was badly formatted.";
      }
      date = moment(date, "YYYYMMDD");
    } else {
      teamAbbr = data.toUpperCase();
    }
    if(abbrHash[teamAbbr]) {
      chosenTeam = abbrHash[teamAbbr].toLowerCase();
    } else {
      chosenTeam = data.toLowerCase();
    }
    if(!date) {
      page = HTTP.read('http://www.extraskater.com/').then(function(b) {
        var $ = cheerio.load(b.toString());
        var gamesToday = $('h3').filter(function() { return $(this).text().indexOf('Games for') > -1; }).next('div.row');
        var chosen = Array.prototype.filter.call(gamesToday.find('table'), function(table) {
          var teams = $(table).find('td:not(.game-status):not(.number-right)');
          teams = Array.prototype.map.call(teams, function(td) { return $(td).text().toLowerCase(); });
          return teams.indexOf(chosenTeam) > -1;
        })[0];
        if(chosen) {
          var uri = 'http://www.extraskater.com' + $(chosen).attr('onclick').replace("location.href='",'').replace("'",'') + "?" + new Date().getTime();
          return HTTP.read(uri);
        } else {
          throw new Error();
        }
      });
    } else {
      var url = 'http://www.extraskater.com/games/all?month=' + date.format('MMM').toLowerCase() + '&season='  + date.format('YYYY');
      page = HTTP.read(url).then(function(b) {
        var $ = cheerio.load(b.toString());

        var label = $("#games-list li strong").filter(function() {
          return $(this).text() === date.format('ddd. MMM. D, 2014');
        });
        if(label && label.parent()) {
          label = label.parent();
        }
        var games = [], curGame = label, link;
        while(true) {
          curGame = curGame.next();
          if(curGame.children('strong').length) break;
          link = curGame.children('a');
          if(link.text().toLowerCase().indexOf(chosenTeam) > -1) {
            return HTTP.read('http://www.extraskater.com' + link.attr('href') + "?" + new Date().getTime());
          }
        }
        throw new Error('no game found');
      });
    }
    return page.then(function(b) {
      var $ = cheerio.load(b.toString());

      var titleParse = $('h2').text().trim().match(/^(\d{4}-\d{2}-\d{2}): (.+) (\d+) at (.+?) (\d+)(?: [\-\-] (\d+:\d+) (\d\w+))?/);
      var s1 = titleParse[3], s2 = titleParse[5];
      var t1 = reverseAbbr(titleParse[2]) + " " + titleParse[3], t2 = reverseAbbr(titleParse[4]) + " " + titleParse[5];
      if(s1 > s2) {
        t1 = bold(t1);
      } else if(s1 < s2) {
        t2 = bold(t2);
      }
      var gameInfo = t1 + " " + t2 + " (";
      gameInfo += (titleParse[6]) ? titleParse[6] + " " + titleParse[7] : "FINAL";
      gameInfo += ")";

      var stats = {};
      var idx = Array.prototype.map.call($('tr.team-game-stats-all').find('td a'), function(el, i){
        return [$(el).text(), i];
      }).filter(function(pair) {
        return pair[0].indexOf(titleParse[2]) > -1;
      });
      idx = idx[0][1];
      Array.prototype.forEach.call($($('tr.team-game-stats-all')[idx]).children('td.number-right'), function(td, i) {
        if(KEYS.esSummary[i]) {
          stats[KEYS.esSummary[i]] = $(td).text();
        }
      });

      var pdoA = humanize.numberFormat(100 * (int(stats.gf) / int(stats.sf) + 1 - int(stats.ga) / int(stats.sa)), 1);
      var pdoH = humanize.numberFormat(100 * (int(stats.ga) / int(stats.sa) + 1 - int(stats.gf) / int(stats.sf)), 1);
      var shA = humanize.numberFormat(100 * int(stats.gf) / int(stats.sf), 1);
      var shH = humanize.numberFormat(100 * int(stats.ga) / int(stats.sa), 1);
      var svA = humanize.numberFormat(100 * (1 - int(stats.ga) / int(stats.sa)), 1);
      var svH = humanize.numberFormat(100 * (1 - int(stats.gf) / int(stats.sf)), 1);

      var summary = [
        gameInfo,
        "SOG " + [stats.sf, stats.sa].join('-'),
        "Corsi " + [stats.cf, stats.ca].join('-'),
        "Fenwick " + [stats.ff, stats.fa].join('-'),
        "Sh% " + [shA, shH].join('-'),
        "Sv% " + [svA, svH].join('-'),
        "PDO " + [pdoA, pdoH].join('-')
      ];
      this.client.say(target, summary.join(" | "));
      return user.nickname + " asked for the fancy game summary for '" + data + "'.";
    }.bind(this), function() {
      this.client.say(target, "No game found.");
      return user.nickname + " asked for the fancy game summary for '" + data + "', but that was not found.";
    }.bind(this));
  },
  "nstats": function(data, user, target) {
    var season = (new Date().getFullYear() - 1) + "-" + (new Date().getYear() % 100);
    return HTTP.read('http://stats.nba.com/stats/commonallplayers/?LeagueID=00&Season=' + season + '&IsOnlyCurrentSeason=1').then(function(b) {
      return JSON.parse(b.toString()).resultSets[0].rowSet;
    }).then(function(players) {
      var match = players.filter(function(player) {
        var ns = player[1].split(", ");
        var name = ns[1] + " " + ns[0];
        return fuzzy.test(data, name);
      }).sort(function(a,b) {
        return a[3] - b[3];
      }).shift();
      if(!match) {
        throw new Error('notfound');
      } else {
        return match[0];
      }
    }).then(function(playerId) {
      var statsQueryData = {
        "Season": season,
        "SeasonType": "Regular+Season",
        "LeagueID": "00",
        "PlayerID": playerId,
        "MeasureType": "Base",
        "PerMode": "PerGame",
        "PlusMinus": "N",
        "PaceAdjust": "N",
        "Rank": "N",
        "Outcome": "",
        "Location": "",
        "Month": "0",
        "SeasonSegment": "",
        "DateFrom": "",
        "DateTo": "",
        "OpponentTeamID": "0",
        "VsConference": "",
        "VsDivision": "",
        "GameSegment": "",
        "Period": "0",
        "LastNGames": "0"
      }, profileQueryData = {
        "asynchFlag": "true",
        "SeasonType": "Regular+Season",
        "LeagueID": "00",
        "PlayerID": playerId
      };
      return Q.all([
        HTTP.read('http://stats.nba.com/stats/playerdashboardbygeneralsplits?' + objToQuery(statsQueryData)).then(function(b) { return JSON.parse(b.toString()); }),
        HTTP.read('http://stats.nba.com/stats/commonplayerinfo/?' + objToQuery(profileQueryData)).then(function(b) { return JSON.parse(b.toString()); })
      ]);
    }).spread(function(stats, profile) {
      var seasonStats = zipHash(stats.resultSets[0].headers, stats.resultSets[0].rowSet[0]);
      var about = zipHash(profile.resultSets[0].headers, profile.resultSets[0].rowSet[0]);
      console.log(seasonStats);
      var positions = about.POSITION.split("-").map(function(p) { return p[0]; }).join("/");
      var firstLine = [
        about.DISPLAY_FIRST_LAST,
        about.TEAM_CITY + " " + positions + " #" + about.JERSEY,
        "Out of " + about.SCHOOL,
        "Born " + moment(about.BIRTHDATE).format("MMMM DD, YYYY")
      ];
      var secondLine = [
        season,
        about.TEAM_ABBREVIATION,
        "GP " + seasonStats.GP,
        "MIN " + seasonStats.MIN,
        "FG% " + Math.round(100 * seasonStats.FG_PCT) + "%",
        "3P% " + Math.round(100 * seasonStats.FG3_PCT) + "%",
        "FT% " + Math.round(100 * seasonStats.FT_PCT) + "%",
        "PTS " + seasonStats.PTS,
        "AST " + seasonStats.AST,
        "REB " + seasonStats.REB,
        "STL " + seasonStats.STL,
        "BLK " + seasonStats.BLK,
        "TO " + seasonStats.TOV,
        "PF " + seasonStats.PF,
        "+/- " + seasonStats.PLUS_MINUS
      ];
      this.client.say(target, firstLine.join(" | ") + "\n" + secondLine.join(" | "));
      return user.nickname + ' searched for NBA player "' + data + '"';
    }.bind(this)).fail(function(e) {
      if(e.message === 'notfound') {
        this.client.say(target, 'No player found.');
        return user.nickname + ' searched for NBA player "' + data + '" but no results were found.';
      } else {
        console.log(e);
      }
    });
  },
  "anstats": function(data, user, target) {
    var season = (new Date().getFullYear() - 1) + "-" + (new Date().getYear() % 100);
    return HTTP.read('http://stats.nba.com/stats/commonallplayers/?LeagueID=00&Season=' + season + '&IsOnlyCurrentSeason=1').then(function(b) {
      return JSON.parse(b.toString()).resultSets[0].rowSet;
    }).then(function(players) {
      var match = players.filter(function(player) {
        var ns = player[1].split(", ");
        var name = ns[1] + " " + ns[0];
        return fuzzy.test(data, name);
      }).sort(function(a,b) {
        return a[3] - b[3];
      }).shift();
      if(!match) {
        throw new Error('notfound');
      } else {
        return match[0];
      }
    }).then(function(playerId) {
      var statsQueryData = {
        "Season": season,
        "SeasonType": "Regular+Season",
        "LeagueID": "00",
        "PlayerID": playerId,
        "MeasureType": "Advanced",
        "PerMode": "PerGame",
        "PlusMinus": "N",
        "PaceAdjust": "N",
        "Rank": "N",
        "Outcome": "",
        "Location": "",
        "Month": "0",
        "SeasonSegment": "",
        "DateFrom": "",
        "DateTo": "",
        "OpponentTeamID": "0",
        "VsConference": "",
        "VsDivision": "",
        "GameSegment": "",
        "Period": "0",
        "LastNGames": "0"
      }, profileQueryData = {
        "asynchFlag": "true",
        "SeasonType": "Regular+Season",
        "LeagueID": "00",
        "PlayerID": playerId
      };
      return Q.all([
        HTTP.read('http://stats.nba.com/stats/playerdashboardbygeneralsplits?' + objToQuery(statsQueryData)).then(function(b) { return JSON.parse(b.toString()); }),
        HTTP.read('http://stats.nba.com/stats/commonplayerinfo/?' + objToQuery(profileQueryData)).then(function(b) { return JSON.parse(b.toString()); })
      ]);
    }).spread(function(stats, profile) {
      var seasonStats = zipHash(stats.resultSets[0].headers, stats.resultSets[0].rowSet[0]);
      var about = zipHash(profile.resultSets[0].headers, profile.resultSets[0].rowSet[0]);
      var positions = about.POSITION.split("-").map(function(p) { return p[0]; }).join("/");
      var firstLine = [
        about.DISPLAY_FIRST_LAST,
        about.TEAM_CITY + " " + positions + " #" + about.JERSEY,
        "Out of " + about.SCHOOL,
        "Born " + moment(about.BIRTHDATE).format("MMMM DD, YYYY")
      ];
      var secondLine = [
        season,
        about.TEAM_ABBREVIATION,
        "GP " + seasonStats.GP,
        "MIN " + seasonStats.MIN,
        "TS% " + Math.round(100 * seasonStats.TS_PCT) + "%",
        "eFG% " + Math.round(100 * seasonStats.EFG_PCT) + "%",
        "USG% " + Math.round(100 * seasonStats.USG_PCT) + "%",
        "ORtg " + seasonStats.OFF_RATING,
        "DRtg " + seasonStats.DEF_RATING,
        "AST% " + Math.round(100 * seasonStats.AST_PCT) + "%",
        "REB% " + Math.round(100 * seasonStats.REB_PCT) + "%",
        "AST/TO " + seasonStats.AST_TO
      ];
      this.client.say(target, firstLine.join(" | ") + "\n" + secondLine.join(" | "));
      return user.nickname + ' searched for NBA player "' + data + '"';
    }.bind(this)).fail(function(e) {
      if(e.message === 'notfound') {
        this.client.say(target, 'No player found.');
        return user.nickname + ' searched for NBA player "' + data + '" but no results were found.';
      }
    });
  },
  "npstats": function(data, user, target) {
    var season = (new Date().getFullYear() - 1) + "-" + (new Date().getYear() % 100);
    return HTTP.read('http://stats.nba.com/stats/commonallplayers/?LeagueID=00&Season=' + season + '&IsOnlyCurrentSeason=1').then(function(b) {
      return JSON.parse(b.toString()).resultSets[0].rowSet;
    }).then(function(players) {
      var match = players.filter(function(player) {
        var ns = player[1].split(", ");
        var name = ns[1] + " " + ns[0];
        return fuzzy.test(data, name);
      }).sort(function(a,b) {
        return a[3] - b[3];
      }).shift();
      if(!match) {
        throw new Error('notfound');
      } else {
        return match[0];
      }
    }).then(function(playerId) {
      var statsQueryData = {
        "Season": season,
        "SeasonType": "Playoffs",
        "LeagueID": "00",
        "PlayerID": playerId,
        "MeasureType": "Base",
        "PerMode": "PerGame",
        "PlusMinus": "N",
        "PaceAdjust": "N",
        "Rank": "N",
        "Outcome": "",
        "Location": "",
        "Month": "0",
        "SeasonSegment": "",
        "DateFrom": "",
        "DateTo": "",
        "OpponentTeamID": "0",
        "VsConference": "",
        "VsDivision": "",
        "GameSegment": "",
        "Period": "0",
        "LastNGames": "0"
      }, profileQueryData = {
        "asynchFlag": "true",
        "SeasonType": "Regular+Season",
        "LeagueID": "00",
        "PlayerID": playerId
      };
      return Q.all([
        HTTP.read('http://stats.nba.com/stats/playerdashboardbygeneralsplits?' + objToQuery(statsQueryData)).then(function(b) { return JSON.parse(b.toString()); }),
        HTTP.read('http://stats.nba.com/stats/commonplayerinfo/?' + objToQuery(profileQueryData)).then(function(b) { return JSON.parse(b.toString()); })
      ]);
    }).spread(function(stats, profile) {
      var seasonStats = zipHash(stats.resultSets[0].headers, stats.resultSets[0].rowSet[0]);
      var about = zipHash(profile.resultSets[0].headers, profile.resultSets[0].rowSet[0]);
      console.log(seasonStats);
      var positions = about.POSITION.split("-").map(function(p) { return p[0]; }).join("/");
      var firstLine = [
        about.DISPLAY_FIRST_LAST,
        about.TEAM_CITY + " " + positions + " #" + about.JERSEY,
        "Out of " + about.SCHOOL,
        "Born " + moment(about.BIRTHDATE).format("MMMM DD, YYYY")
      ];
      var secondLine = [
        season,
        about.TEAM_ABBREVIATION,
        "GP " + seasonStats.GP,
        "MIN " + seasonStats.MIN,
        "FG% " + Math.round(100 * seasonStats.FG_PCT) + "%",
        "3P% " + Math.round(100 * seasonStats.FG3_PCT) + "%",
        "FT% " + Math.round(100 * seasonStats.FT_PCT) + "%",
        "PTS " + seasonStats.PTS,
        "AST " + seasonStats.AST,
        "REB " + seasonStats.REB,
        "STL " + seasonStats.STL,
        "BLK " + seasonStats.BLK,
        "TO " + seasonStats.TOV,
        "PF " + seasonStats.PF,
        "+/- " + seasonStats.PLUS_MINUS
      ];
      this.client.say(target, firstLine.join(" | ") + "\n" + secondLine.join(" | "));
      return user.nickname + ' searched for NBA player "' + data + '"';
    }.bind(this)).fail(function(e) {
      if(e.message === 'notfound') {
        this.client.say(target, 'No player found.');
        return user.nickname + ' searched for NBA player "' + data + '" but no results were found.';
      } else {
        console.log(e);
      }
    });
  },
  "_help": {
    "cap": "Display cap information about a player. Usage: cap player_name",
    "astats": "Display advanced stats for a player. Usage: astats player_name",
    "stats": "Display stats for a player. Usage: stats player_name",
    "asummary": "Display an advanced summary for a game. Usage: asummary [YYYYMMDD] team_abbreviation",
  }
};
