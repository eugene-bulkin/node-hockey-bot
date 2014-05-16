module.exports = {
  throttle: function(data, user, target) {
    if(!this.isAdmin(user)) {
      this.client.say(target, "You are not authorized to use that command.");
      return user.nickname + " tried to throttle.";
    }
    var s = data.split(' ');
    if(s.length < 2 || !s[0].match(/-?[nh]/)) {
      this.client.say(target, "Incorrect usage.");
      return "Bad throttle arguments: " + data;
    }
    var triggerId = 'throttle;' + s[0].replace('-','') + ';' + s[1];
    if(s[0][0] === '-') {
      this.removeTrigger('before', triggerId);
      this.client.say(target, "Throttle trigger successfully removed.");
      return user.nickname + " removed throttle: " + data;
    } else {
      var handler = (function() {
        var messageStack = [];
        return function(data, user, target) {
          if(messageStack.length < 3) {
            messageStack.push(new Date());
            return true;
          }
          var old = messageStack.shift();
          var newDate = new Date();
          messageStack.push(newDate);
          return newDate - old < 10000;
        };
      })();
      this.registerTrigger('before', triggerId, handler);
      this.client.say(target, "Throttle trigger successfully added.");
      return user.nickname + " added throttle trigger: " + data;
    }
  },
  ignore: function(data, user, target) {
    if(!this.isAdmin(user)) {
      this.client.say(target, "You are not authorized to use that command.");
      return user.nickname + " tried to ignore.";
    }
    var s = data.split(' ');
    if(s.length < 2 || !s[0].match(/-?[nh]/)) {
      this.client.say(target, "Incorrect usage.");
      return "Bad ignore arguments: " + data;
    }
    var triggerId = 'ignore;' + s[0].replace('-','') + ';' + s[1];
    if(s[0][0] === '-') {
      this.removeTrigger('before', triggerId);
      this.client.say(target, "Ignore trigger successfully removed.");
      return user.nickname + " removed ignore: " + data;
    } else {
      if(s[0] === 'n') {
        var fn = function(data, user, target) {
          return user.nickname !== s[1];
        };
      } else {
        var fn = function(data, user, target) {
          return user.host !== s[1];
        };
      }
      this.registerTrigger('before', triggerId, fn);
      this.client.say(target, "Ignore trigger successfully added.");
      return user.nickname + " added ignore: " + data;
    }
  },
  "reload": function(data, user, target) {
    if(!this.isAdmin(user)) {
      this.client.say(target, "You are not authorized to use that command.");
      return user.nickname + " tried to reload the modules.";
    }
    return this.loadCommands().then(function() {
      this.client.say(target, "Done.");
      return user.nickname + " reloaded my modules.";
    }.bind(this));
  },
  "_help": {
    "~throttle": "Prevents a user from sending more than 3 commands in a short period of time. Usage: throttle [-]n nickname or throttle [-]h host",
    "~ignore": "Ignores a user's command requests. Usage: throttle [-]n nickname or throttle [-]h host",
    "~reload": "Reloads the internal modules."
  }
};