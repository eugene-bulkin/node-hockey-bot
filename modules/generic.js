module.exports = {
  "about": function(data, user, target) {
    this.client.say(target, "I'm a bot!");
    return user.nickname + " asked about me.";
  },
  "reload": function(data, user, target) {
    return this.loadCommands().then(function() {
      this.client.say(target, "Done.");
      return user.nickname + " reloaded my modules.";
    }.bind(this));
  }
};