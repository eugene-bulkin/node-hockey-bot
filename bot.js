var irc = require('irc');
var Q = require('q');
var FS = require('q-io/fs');
var moment = require('moment');
var QSQL = require('q-sqlite3');

/*
 * Command line arguments, e.g. node bot.js -e testing
 *
 * -h = help
 * -e = set environment
 */
var argvOpts = {
  alias: {
    "env": "e"
  },
  default: {
    "env": "testing"
  }
};
var argv = require('minimist')(process.argv.slice(2), argvOpts);

// Open the config.json file. If this errors, a config.json file doesn't exist!
try {
  var config = require('./config.json');
} catch(e) {
  console.error("ERROR: config.json not found. Did you make sure to create it?");
  process.exit();
}
/*
 * Pull out the chosen server config based on the environment chosen.
 * Throw some sort of error if it doesn't work.
 */
var server = config.environments[argv.env];
if (!server) {
  console.error("ERROR: No server information found. Try choosing another environment.");
  process.exit();
} else {
  console.log("Running bot in '" + argv.env + "' environment.");
}
/*
 * Here we create the bot class. It's simply a wrapper for the irc client and
 * logging capabilities.
 */
var Bot = function() {
  // store current nickname
  this.currentNick = server.nickname;
  // initialize triggers
  this.triggers = {
    'before': {},
    'after': {}
  };
  // Set up help dictionary
  this.help = {};
  // Create regular expression for matching commands.
  // This escapes any characters that may be in the command prefix for use in a
  // regular expression. See http://stackoverflow.com/a/3561711/28429
  var prefix = config.cmdPrefix.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  this.cmdRegex = new RegExp('^' + prefix + '([a-zA-Z][a-zA-Z0-9]*)(?:\\s*(.*)|$)');
  // Make sure we can log things before we do anything else! Then
  // load commands in (which is async)
  this.setupLogs().then(this.loadCommands.bind(this)).then(this.initializeDatabase.bind(this)).done(function() {

    this.client = new irc.Client(server.server, server.nickname, {
      channels: server.channels,
      floodProtection: true,
      floodProtectionDelay: 750
    });

    // Set up client listeners
    this.setupListeners();
  }.bind(this));
};

Bot.prototype.initializeDatabase = function() {
  return QSQL.createDatabase('./db.sqlite').then(function(db) {
    this.db = db;
    return this.db;
  }.bind(this)).then(function(db) {
    // separate this out here for readability
    var tables = [
      "CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY, data TEXT)",
      "CREATE TABLE IF NOT EXISTS player_search (id INTEGER PRIMARY KEY, query TEXT, players_id INTEGER)",
      "CREATE TABLE IF NOT EXISTS stats_yahoo_reg (id INTEGER PRIMARY KEY, web_id TEXT, data TEXT, players_id INTEGER)",
      "CREATE TABLE IF NOT EXISTS stats_es_reg (id INTEGER PRIMARY KEY, web_id TEXT, data TEXT, players_id INTEGER)",
      "CREATE TABLE IF NOT EXISTS stats_cap (id INTEGER PRIMARY KEY, web_id TEXT, data TEXT, players_id INTEGER)"
    ];
    return QSQL.exec(db, tables.join("; "));
  });
};


Bot.prototype.setupLogs = function() {
  // override default log directory with environment-specific one if it exists
  var logDirectory = config.logging.directory;
  if (server.logging && server.logging.directory) {
    logDirectory = server.logging.directory;
  }
  var pathName = logDirectory + "/bot.log";
  // first we check if the directory exists...
  return FS.isDirectory(logDirectory).then(function(isDirectory) {
    if(!isDirectory) {
      // if it doesn't, make it!
      return FS.makeTree(logDirectory);
    }
  }).then(function() {
    return FS.list(logDirectory);
  }).then(function(list) {
    // then if there already exists a log file, archive it out so log files
    // don't get too huge.
    if (list.indexOf('bot.log') > -1) {
      return FS.move(pathName, pathName + "." + list.length);
    }
  });
};

/*
 * What this function does is set up all the IRC client listeners, such as
 * knowing when we've connected to the server, joined a channel, etc.
 */
Bot.prototype.setupListeners = function() {
  // This is the event sent by the server when we successfully connect.
  this.client.addListener('registered', function(message) {
    // this server message tells us what nickname we're actually using
    this.currentNick = message.args[0];
    this.log('Connected to the server: ' + server.server);
  }.bind(this));
  // This event is sent every time we join a channel.
  this.client.addListener('names', function(channel, nicks) {
    this.log('Joined ' + channel);
  }.bind(this));
  // Handle receiving messages. Can be PM or in channel (depending on to
  // argument)
  this.client.addListener('message', this.onMessage.bind(this));
};

/*
 * This is the message handler. See node-irc documentation for description of
 * parameters.
 */
Bot.prototype.onMessage = function(nick, to, text, message) {
  var cmdExec = this.cmdRegex.exec(text);
  // If there was no command, we don't care what was said
  if(!cmdExec) {
    return;
  }
  // Pull the information about the command from the regular expression
  var command = cmdExec[1];
  var data = cmdExec[2] || '';
  // Store some information about the user
  var user = {
    nickname: message.nick,
    username: message.user,
    host: message.host
  };
  /*
   * If to is the same as our nickname, that means it came from a PM, so we want
   * to send it back to that user. Otherwise it's a channel, so that's where it
   * belongs.
   */
  var target = (to === this.currentNick) ? user.nickname : to;

  /*
   * Here we wrap the command call with a promise. If the command call is
   * synchronous, nothing interesting happens. But if we want to do something
   * specifically after a command is done executing, we want to ensure it
   * happens afterwards, so we cover asynchronous commands as well. This means
   * any asynchronous commands need to return a promise.
   *
   * The done handler does two things:
   * 1. Ensures that any uncaught exceptions are caught and logged
   * 2. Provides a way for commands to send back a message for logging
   */
  var beforeTriggers = Object.keys(this.triggers.before).every(function(id) {
    try {
      return this.triggers.before[id].call(this, data, user, target);
    } catch(e) {
      this.logError("The following error occurred while trying to run the command '" + command + "' with arguments '" + data + "': " + err.message);
      return false;
    }
  }, this);
  if(!beforeTriggers) {
    return;
  }
  Q.fcall(function() {
    if (this.commands[command]) {
      return this.commands[command].call(this, data, user, target);
    } else {
      return user.nickname + " tried to use the nonexistent command '" + command + "'.";
    }
  }.bind(this)).then(function(msg) {
    Object.keys(this.triggers.after).forEach(function(id) {
      this.triggers.after[id].call(this, data, user, target);
    }, this);
    return msg;
  }.bind(this), function(e) {
    Object.keys(this.triggers.after).forEach(function(id) {
      this.triggers.after[id].call(this, data, user, target);
    }, this);
    throw e;
  }.bind(this)).done(function(message) {
    if(message) {
      this.log(message);
    }
  }.bind(this), function(err) {
    this.logError("The following error occurred while trying to run the command '" + command + "' with arguments '" + data + "': " + err.message);
  }.bind(this));
};

Bot.prototype.registerTrigger = function(time, id, cb) {
  if (!this.triggers[time] || !id || !cb) {
    return;
  }
  this.triggers[time][id] = cb;
};

Bot.prototype.removeTrigger = function(time, id) {
  if (!this.triggers[time] || !id) {
    return;
  }
  delete this.triggers[time][id];
};

/*
 * Loads all the commands the bot will use.
 */
Bot.prototype.loadCommands = function() {
  this.commands = {};
  /*
   * WARNING: HACKY
   *
   * Node does not support hard reloading required files. As a result, the only
   * way to ensure we get the newest version of the file is to remove it from
   * the cache before we re-require it. So what we do is pull all the keys
   * from the cache that are in the modules directory, then remove them from
   * the cache. If loadedModules is empty this simply means we haven't loaded
   * any yet.
   */
  var moduleDir = process.env.PWD + "/modules";
  var loadedModules = Object.keys(require.cache).filter(function(file) {
    return file.indexOf(moduleDir) === 0;
  });
  loadedModules.forEach(function(module) {
    delete require.cache[module];
  });
  // Now we look through the modules list and require them as necessary
  return FS.list('modules').then(function(list) {
    var numModules = 0, numFns = 0;
    list.forEach(function(file) {
      // we only want JS files here
      if(file.split(".").pop() !== 'js') {
        return;
      }
      numModules++;
      var module = require('./modules/' + file);
      // Combine that module with our internal commands object
      Object.keys(module).forEach(function(key) {
        if (key === '_setup') {
          module[key].call(this);
          return;
        } else if(key === '_help') {
          for(var helpKey in module[key]) {
            this.help[helpKey] = module[key][helpKey];
          }
          return;
        }
        this.commands[key] = module[key];
        numFns++;
      }, this);
    }, this);
    console.log(numModules + " module(s) loaded with " + numFns + " function(s) total.");
  }.bind(this));
};

/*
 * This is a wrapper for the bot client disconnect. We do this because we need
 * a promise version of the client disconnect, in case we need to safely
 * disconnect and then do some logging or try to reconnect, or so on.
 */
Bot.prototype.disconnect = function(message) {
  var deferred = Q.defer();
  this.client.disconnect(message, function() {
    deferred.resolve();
  });
  return deferred.promise;
};

/*
 * Cleans up anything that needs to be cleaned up, like the database.
 */
Bot.prototype.cleanUp = function() {
  if(this.db) {
    return QSQL.close(this.db);
  }
};

/* Logging here */
var LOG_TYPES = {
  "ALL": 3,
  "ERROR": 2,
  "LOG": 1
};

Bot.prototype.logInternal = function(message, type) {
  var currentLevel = config.logging.level;
  // so we can override the default on a per-environment basis
  if (server.logging && server.logging.level) {
    currentLevel = server.logging.level;
  }
  // Performing a bit-wise and on the passed in log level and the config log
  // level will return zero if we don't want to log this type, and a positive
  // number (i.e. a truthy value) if we do.
  if(!(LOG_TYPES[currentLevel] & type)) {
    return;
  }
  var logData = [];
  // append a timestamp
  logData.push(moment().format("MM-DD-YYYY hh:mm:ss A"));
  // append type of log message
  logData.push((type === LOG_TYPES.ERROR) ? "ERROR" : "LOG");
  // append log message
  logData.push(message);

  var logStr = "[" + logData[0] + "] (" + logData[1] +") " + logData[2];

  // again, override default if environment has specific directory
  var logDirectory = config.logging.directory;
  if (server.logging && server.logging.directory) {
    logDirectory = server.logging.directory;
  }
  // write to log and also spit out to console for convenience
  // we return a promise here in case we need to do something AFTER a log has
  // occurred
  return FS.append(logDirectory + "/bot.log", logStr + "\n").then(function() {
    console.log(logStr);
  });
};

/* Below are aliases for logging, so you don't have to deal with types */
Bot.prototype.log = function(message) {
  return this.logInternal(message, LOG_TYPES.LOG);
};

Bot.prototype.logError = function(message) {
  return this.logInternal(message, LOG_TYPES.ERROR);
};

Bot.prototype.isAdmin = function(user) {
  return server.admin.indexOf(user.nickname) > -1;
};

// Create the bot and join the server and relevant channels
var bot = new Bot();

/*
 * Handle interrupt and manual kill logging.
 *
 * We wait for the logging and client disconnecting to finish, and then
 * cleanly exit the process.
 */
process.on('SIGINT', function(code) {
  Q.all([
    bot.log("Bot manually killed with SIGINT"),
    bot.disconnect('Adios!'),
    bot.cleanUp()
  ]).done(function() {
    process.exit(code || 1);
  });
});

process.on('SIGTERM', function(code) {
  Q.all([
    bot.log("Bot manually killed with SIGTERM"),
    bot.disconnect(),
    bot.cleanUp()
  ]).done(function() {
    process.exit(code || 1);
  });
});

process.on('uncaughtException', function(e) {
  bot.logError("Uncaught exception: " + JSON.stringify(e));
});
