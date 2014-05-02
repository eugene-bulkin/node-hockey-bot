var irc = require('irc');
var Q = require('q');

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
}
/*
 * Here we create the bot class. It's simply a wrapper for the irc client and
 * logging capabilities.
 */
var Bot = function() {
  this.client = new irc.Client(server.server, server.nickname, {
    channels: server.channels
  });

  this.setupListeners();

  // Create regular expression for matching commands.
  // This escapes any characters that may be in the command prefix for use in a
  // regular expression. See http://stackoverflow.com/a/3561711/28429
  var prefix = config.cmdPrefix.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  this.cmdRegex = new RegExp('^' + prefix + '([a-zA-Z][a-zA-Z0-9]*)(?:\\s*(.*)|$)');

  // Load commands into bot
  this.loadCommands();
};

/*
 * What this function does is set up all the IRC client listeners, such as
 * knowing when we've connected to the server, joined a channel, etc.
 */
Bot.prototype.setupListeners = function() {
  // This is the event sent by the server when we successfully connect.
  this.client.addListener('registered', function(message) {
    console.log('Connected to the server: ' + server.server);
  });
  // This event is sent every time we join a channel.
  this.client.addListener('names', function(channel, nicks) {
    console.log('Joined ' + channel);
  });
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
  var target = (to === server.nickname) ? user.nickname : to;

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
  Q.fcall(function() {
    if (this.commands[command]) {
      return this.commands[command].call(this, data, user, target);
    } else {
      return user.nickname + " tried to use the nonexistent command '" + command + "'.";
    }
  }.bind(this)).done(function(message) {
    if(message) {
      console.log(message);
    }
  }, function(err) {
    console.log("The following error occurred while trying to run the command '" + command + "' with arguments '" + data + "': " + err.message);
  });
};

/*
 * Loads all the commands the bot will use.
 */
Bot.prototype.loadCommands = function() {
  this.commands = {
    "about": function(data, user, target) {
      this.client.say(target, "I'm a bot!");
      return user.nickname + " asked about me.";
    }
  };
};

// Create the bot and join the server and relevant channels
var bot = new Bot();