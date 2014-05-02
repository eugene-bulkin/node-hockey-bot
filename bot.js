var irc = require('irc');

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
  this.client.addListener('message', function(nick, to, text, message) {
    console.log('Received message from ' + nick + ' to ' + to + ' with content "' + text + '"');
  });
};

// Create the bot and join the server and relevant channels
var bot = new Bot();