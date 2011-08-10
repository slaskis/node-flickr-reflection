/**
 * Flickr api client for node.js
 * inspired by node-flickr (http://github.com/edds/node-flickr/)
 * works on flickrs reflection api
 *
 * created by Timo Derstappen (http://teemow.com/)
 */

var http = require('http')
  , sys = require('sys')
  , path = require('path')
  , fs = require('fs')
  , crypto = require('crypto');

var api = {};
var api_key = '';
var secret = '';

/**
 * construct a url given a method and optional arguments
 */
function getUrl(method, sign_required, args) {
  args = args || {};
  // add in the extra arguments for calls
  var standard_args = {
    format: "json",
    api_key: api_key,
    nojsoncallback: '1',
    method: method
  };

  var output = []
    , sign = [];
  for(var p in args){
    output.push(p + '=' + encodeURIComponent(args[p]));
    sign_required && sign.push(p + args[p]);
  }
  for(var p in standard_args){
    output.push(p + '=' + encodeURIComponent(standard_args[p]));
    sign_required && sign.push(p + standard_args[p]);
  }
  if (sign_required) {
    output.push('api_sig=' + getSignature(sign));
  }
  return "http://api.flickr.com/services/rest/?" + output.join('&');
}

/**
 * Create a signature for flickr api requests
 */
function getSignature(params) {
  var hash = crypto.createHash('md5');
  hash.update(secret + params.sort().join(''));
  return hash.digest('hex');
}

function cacheExists(callback) {
  path.exists('cache', function(exists) {
    if (!exists) {
      fs.mkdir('cache', 0700, function(err) {
        if (err) {
          return callback(err);
        }
        callback(null);
      });
    } else {
      callback(null);
    }
  });
}

var memoryCache = {};
function readCache(file, callback) {
  if( memoryCache[file] ){
    callback(null,memoryCache[file])
  } else {
    cacheExists(function(err) {
      if (err) {
        return callback(err);
      }
      fs.readFile('cache/' + file, 'utf8', callback);
    });
  }
}

function writeCache(file, data, callback){
  memoryCache[file] = data;
  fs.writeFile('cache/' + file, data, callback);
}

function getFrob(callback) {
  readCache('frob', function(err, data) {
    if (err) {
      return api.auth.getFrob(function(err, data) {
        if (err) {
          return callback(err);
        }
        writeCache('frob', data.frob._content);
        callback(null, data.frob._content);
      });
    }
    callback(null, data.replace(/\s/g, ''));
  });
}

function getToken(frob,callback) {
  readCache('token', function(err, data) {
    if (err) {
      return api.auth.getToken({frob: frob}, function(err, data) {
        if (err) {
          var params = [
            'api_key=' + api_key,
            'perms=read',
            'frob=' + frob
          ];
          
          var sign = params.map(function(p){return p.replace("=",'')});
          params.push('api_sig=' + getSignature(sign));
          
          var url = 'http://flickr.com/services/auth/?' + params.join('&');
          err = new Error('Need to link to account - Open this url in your browser: ' + url);

          return callback(err, data);
        }
        writeCache('token', data.auth.token._content);
        callback(null, data.auth.token._content);
      });
    }
    callback(null, data.replace(/\s/g, ''));
  });
}

/**
 * create the request to api.flickr.com
 */
function createRequest(url, callback){
  var headers = {
     'Accept': '*/*',
     'Host': 'api.flickr.com',
     'User-Agent': 'node.js'
  };
  var client = http.createClient(80, "api.flickr.com");
  var req = client.request('POST', url, headers);
  req.on('response', function (response) {
    var body = '';
    response.setEncoding("utf8");
    response.on('data', function(chunk) {
      body += chunk;
    });
    response.on('end', function() {
      var data = JSON.parse(body);
      if (typeof callback === 'function') {
        if (data.stat === 'ok') {
          callback(null, data);
        } else {
          callback(new Error('Flickr: ' + data.message + ' - ' + data.code + " on "+url));
        }
      }
    });
  });
  req.end();
}

function auth(required, callback) {
  if (!required) {
    return readCache('token', function(err,token){
      if( err )
        callback();
      else
        callback(null,token)
    });
  }
  if (!secret) {
    return callback(new Error('you are using a signed method please add your api secret'));
  }

  getFrob(function(err, frob) {
    if (err) {
      return callback(err);
    }
    getToken(frob,function(err, token) {
      if (err) {
        return callback(err);
      }
      callback(null, token);
    });
  });
}

function request(method, sign_required, auth_required) {
  auth_required = auth_required || false;
  sign_required = sign_required || false;

  return function(options,callback) {
    if (typeof options == 'function')
      callback = options, options = {};
    
    if( options.force_sign ){
      sign_required = auth_required = options.force_sign;
      delete options.force_sign;
    }
    
    auth(auth_required, function(err, data) {
      if (err) {
        return callback(err);
      }
      if (auth_required) {
        options.auth_token = data;
      }

      var url = getUrl(method, sign_required, options);
      createRequest(url, callback);
    });
  };
}

exports.connect = function(options, callback) {
  if (typeof callback !== 'function') {
    throw new Error('You should use a callback to work with the api');
  }
  if (typeof options.key === 'undefined') {
    return callback(new Error('flickr api key needed'));
  }
  if (typeof options.apis === 'undefined') {
    return callback(new Error('please specify which apis you\'d like to use'));
  }
  api_key = options.key;
  if (typeof options.secret !== 'undefined') {
    secret = options.secret;
  }

  request('flickr.reflection.getMethods')(function(err, data) {
    if( err ){
      return callback(err);
    }
    
    var pending = 0;
    data.methods.method.forEach(function(item) {
      var path = item._content.replace("flickr.", "").split('.');

      var needed = false;
      if (path[0] === 'auth') {
        needed = true;
      } else {
        options.apis.forEach(function(api_needed) {
          if (path[0] === api_needed) {
            needed = true;
          }
        });
      }
      if (!needed) {
        return false;
      }
      pending++;

      var level = api;
      var method = path.pop();

      path.forEach(function(part) {
        if (typeof level[part] === 'undefined') {
          level[part] = {};
        }
        level = level[part]
      });

      request('flickr.reflection.getMethodInfo')({"method_name": item._content}, function(err, info) {
        if (info.method.name.indexOf('flickr.auth') === 0) {
          // bug in flickr api?
          info.method.needssigning = 1;
        }
        level[method] = request(info.method.name, info.method.needssigning === 1, info.method.needslogin === 1)
        
        --pending || callback(null, api);
      });
    });
  });
}

