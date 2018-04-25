"use strict";

var _ = require('lodash');
var pathToRegexp = require('path-to-regexp');

var swagger = {
  swagger: "2.0",
  info: {},
  paths: {},
  definitions: {}
};

function toSwagger(apidocJson, projectJson, types, ignoreGroups) {
  swagger.info = addInfo(projectJson);
  if (projectJson.url) {
    var url = projectJson.url;
    var schemeEnd = url.indexOf('://');
    if (schemeEnd >= 0) {
      swagger.schemes = [url.substring(0, schemeEnd)];
      url = url.substring(schemeEnd + 3);
    }
    else {
      swagger.schemes = ['http', 'https'];
    }
    var pathStart = url.indexOf('/');
    if (pathStart >= 0) {
      swagger.host = url.substring(0, pathStart);
      url = url.substring(pathStart);
    }
    swagger.basePath = url;
  }
  if (types) {
    // convert all group names to lowercase
    ignoreGroups = ignoreGroups.map(group => group.toLowerCase());
    // add reserved group names
    ignoreGroups.push('parameter');
    ignoreGroups.push('request body fields');
    swagger.definitions = extractDefinitions(apidocJson, ignoreGroups);
  }
  else {
    ignoreGroups = null;
  }
  swagger.paths = extractPaths(apidocJson, ignoreGroups);
  return swagger;
}

var tagsRegex = /(<([^>]+)>)/ig;

// Removes <p> </p> tags from text
function removeTags(text) {
  return text ? text.replace(tagsRegex, "") : text;
}

function addInfo(projectJson) {
  var info = {};
  info["title"] = projectJson.title || projectJson.name;
  info["version"] = projectJson.version;
  info["description"] = projectJson.description;
  return info;
}

/**
 * Converts a text to camel case like name by removing all spaces and converting
 * each character after a space to upper case.
 *
 * 'Some text value' => 'SomeTextValue'
 *
 * @param {string} aText
 *   Text to convert
 *
 * @return {string} converted text
 */
function convertToCamelCase(aText) {
  let parts = aText.split(' ').map(value =>
    value.length > 0 ? value[0].toUpperCase() + value.substring(1) : ''
  );
  return parts.join('');
}

/**
 * Extract all parameter definitions that uses non standard groups as complex
 * type definition.
 *
 * @param {object} apidocJson
 *
 * @param {string[]} ignoreGroups
 *   Group names to ignore as type definition
 *
 * @return {{}} definition
 */
function extractDefinitions(apidocJson, ignoreGroups) {
  const result = {};
  apidocJson.forEach(apiCall => {
    if (apiCall.parameter && apiCall.parameter.fields) {
      _.each(apiCall.parameter.fields, (fields, group) => {
        if (ignoreGroups.indexOf(group.toLowerCase()) < 0) {
          fields.forEach(field => addDefinition(result, field));
        }
      });
    }
  });
  return result;
}

/**
 * Adds a field definition to a specific type definition using its group name.
 * If a definition is already existing, the field definition is ignored.
 *
 * @param {object} aDefinitions
 *   Swagger definitions
 * @param {object} aField
 *   Field to add
 */
function addDefinition(aDefinitions, aField) {
  if (!aDefinitions.hasOwnProperty(aField.group)) {
    aDefinitions[aField.group] = {
      properties: {},
      required: []
    }
  }
  const definition = aDefinitions[aField.group];
  if (!definition.properties.hasOwnProperty(aField.field)) {
    definition.properties[aField.field] = {
      type: toSwaggerFieldType(aField.type),
      description: removeTags(aField.description)
    };
    if (!aField.optional) {
      definition.required.push(aField.field);
    }
  }
}

function toSwaggerFieldType(type) {
  if(type === 'Number' || 'String' || 'Boolean' || 'Integer' || 'Object' || 'Array') {
    return type.toLowerCase()
  }
  return type;
}

/**
 * Extracts paths provided in json format
 * post, patch, put request parameters are extracted in body
 * get and delete are extracted to path parameters
 * @param {object} apidocJson
 * @param {string[]} ignoreGroups
 * @returns {{}}
 */
function extractPaths(apidocJson, ignoreGroups) {
  var apiPaths = groupByUrl(apidocJson);

  var paths = {};
  for (var i = 0; i < apiPaths.length; i++) {
    var verbs = apiPaths[i].verbs;
    var url = verbs[0].url;
    var pattern = pathToRegexp(url, null);
    var matches = pattern.exec(url);

    // Surrounds URL parameters with curly brackets -> :email with {email}
    var pathKeys = [];
    for (var j = 1; j < matches.length; j++) {
      var key = matches[j].substr(1);
      url = url.replace(matches[j], "{" + key + "}");
      pathKeys.push(key);
    }

    for (var j = 0; j < verbs.length; j++) {
      var verb = verbs[j];
      var type = verb.type;

      var obj = paths[url] = paths[url] || {};

      //apiDoc allows to name parameter groups (in round braces) and these groups
      // represented in verbs.parameter.fields by their names, in group not
      // defined explicitly it named Parameter
      if (verb.parameter) {

        const flattenFields = {
          Parameter: []
        };
        _.each(verb.parameter.fields, (fields, group) => {
          if ((ignoreGroups === null) || (ignoreGroups.indexOf(group.toLowerCase()) >= 0)) {
            flattenFields.Parameter = flattenFields.Parameter.concat(fields);
          }
        });
        /*
        verb.parameter.fields = {
          Parameter: _.flatten(_.values(verb.parameter.fields))
        };
        */
        verb.parameter.fields = flattenFields;
      }
      if (verb.header) {
        verb.header.fields = {
          Header: _.flatten(_.values(verb.header.fields))
        };
      }
      if (type == 'post' || type == 'patch' || type == 'put') {
        _.extend(obj, createPostPushPutOutput(verb, swagger.definitions, pathKeys));
      }
      else {
        _.extend(obj, createGetDeleteOutput(verb, swagger.definitions, pathKeys));
      }
      paths[url][type].operationId = verb.name;
    }
  }
  return paths;
}

function createPostPushPutOutput(verbs, definitions, pathKeys) {
  var pathItemObject = {};
  var params = [];
  if (verbs.parameter && verbs.parameter.fields) {
    if (verbs.parameter.fields.Parameter) {
      //path params
      params = params.concat(
        createParameters(
          verbs.parameter.fields.Parameter.filter(function (param) {
            return pathKeys.indexOf(param.field) >= 0 && param.group !== 'Request Body Fields';
          }),
          'path'
        )
      );
    }
  }
  //find everything in Parameters that is in thr group request body fields
  var bodyFields = verbs.parameter.fields.Parameter
    .filter(function (param) {
      return param.group === 'Request Body Fields';
    })
    .map(function (field) {
      field.field = verbs.name + 'Body.' + field.field;
      return field;
    });
  if (bodyFields.length > 0) {
    bodyFields = [{
      field: verbs.name + "Body",
      type: "Object"
    }].concat(bodyFields);
    params.push(
      {
        "in": "body",
        "name": verbs.name + "Body",
        "description": removeTags(verbs.description),
        "required": true,
        "schema": createSchema(
          bodyFields, definitions, verbs.name + "Body", verbs.name + "Body"
        )
      }
    );
  }
  if (verbs.header && verbs.header.fields && verbs.header.fields.Header) {
    //header params
    params = params.concat(
      createParameters(
        verbs.header.fields.Header,
        'header'
      )
    );
  }

  pathItemObject[verbs.type] = {
    tags: [verbs.group],
    summary: removeTags(verbs.title),
    description: removeTags(verbs.description),
    consumes: [
      "application/json"
    ],
    produces: [
      "application/json"
    ],
    parameters: params
  };

  pathItemObject[verbs.type].responses = _.merge(
    createSuccessResults(verbs, definitions),
    createErrorResults(verbs, definitions)
  );
  return pathItemObject;
}

/**
 * Generate get, delete method output
 * @param verbs
 * @returns {{}}
 */
function createGetDeleteOutput(verbs, definitions, pathKeys) {
  var pathItemObject = {};
  verbs.type = verbs.type === "del" ? "delete" : verbs.type;

  var params = [];
  if (verbs.parameter && verbs.parameter.fields) {
    if (verbs.parameter.fields.Parameter) {
      params = params.concat(
        createParameters(
          verbs.parameter.fields.Parameter.filter(function (param) {
            return pathKeys.indexOf(param.field) >= 0;
          }),
          'path'
        ),
        createParameters(
          verbs.parameter.fields.Parameter.filter(function (param) {
            return pathKeys.indexOf(param.field) < 0;
          }),
          'query'
        )
      );
    }
  }
  if (verbs.header && verbs.header.fields && verbs.header.fields.Header) {
    params = params.concat(
      createParameters(
        verbs.header.fields.Header,
        'header'
      )
    );
  }

  pathItemObject[verbs.type] = {
    tags: [verbs.group],
    summary: removeTags(verbs.title),
    description: removeTags(verbs.description),
    consumes: [
      "application/json"
    ],
    produces: [
      "application/json"
    ],
    parameters: params
  };

  pathItemObject[verbs.type].responses = _.merge(
    createSuccessResults(verbs, definitions),
    createErrorResults(verbs, definitions)
  );
  return pathItemObject;
}

function createFieldArrayDefinitions(fieldArray, definitions, topLevelRef, defaultObjectName) {
  var result = {
    topLevelRef: topLevelRef,
    topLevelRefType: null
  }

  if (!fieldArray) {
    return result;
  }

  for (var i = 0; i < fieldArray.length; i++) {
    var parameter = fieldArray[i];

    var nestedName = createNestedName(parameter.field);
    var objectName = nestedName.objectName;
    if (!objectName) {
      objectName = defaultObjectName;
    }
//    if (parameter.type.toLowerCase() == "object[]") parameter.type = "Array";
    var type = parameter.type || "";
    if (i == 0) {
      result.topLevelRefType = type;
      if (parameter.type == "Object") {
        objectName = nestedName.propertyName;
        nestedName.propertyName = null;
      }
      else if (parameter.type == "Array") {
        objectName = nestedName.propertyName;
        nestedName.propertyName = null;
        result.topLevelRefType = "array";
      }
      result.topLevelRef = objectName;
    }
    ;

    definitions[objectName] = definitions[objectName] ||
      {properties: {}, required: []};

    if (nestedName.propertyName) {
      var prop = {
        type: (type.toLowerCase() || "").toLowerCase(),
        description: removeTags(parameter.description)
      };
      var typeIndex = type.indexOf("[]");
      if (parameter.type == "Object") {
        prop.$ref = "#/definitions/" + parameter.field;
      }
      if (typeIndex !== -1 && typeIndex === (type.length - 2)) {
        type = type.slice(0, type.length - 2);
        prop.type = "array";
        if (type.toLowerCase() == "object") {
          prop.items = {"$ref": "#/definitions/" + parameter.field};
        }
        else if (swagger.definitions.hasOwnProperty(type)) {
          prop.items = {"$ref": "#/definitions/" + type};
        }
        else {
          prop.items = {type: type.toLowerCase()};
        }
      }
      else if (swagger.definitions.hasOwnProperty(type)) {
        prop.$ref = "#/definitions/" + type;
      }
      definitions[objectName]['properties'][nestedName.propertyName] = prop;
      if (!parameter.optional) {
        var arr = definitions[objectName]['required'];
        if (arr.indexOf(nestedName.propertyName) === -1) {
          arr.push(nestedName.propertyName);
        }
      }
      ;

    }
    ;
  }

  return result;
}

function createNestedName(field) {
  var propertyName = field;
  var objectName;
  var propertyNames = field.split(".");
  if (propertyNames && propertyNames.length > 1) {
    propertyName = propertyNames[propertyNames.length - 1];
    propertyNames.pop();
    objectName = propertyNames.join(".");
  }

  return {
    propertyName: propertyName,
    objectName: objectName
  }
}

function createSchema(fields, definitions, defName, objName, isResult) {
  if (!objName) {
    objName = defName;
  }
  var schema = {};
  var fieldType = fields[0] ? (fields[0].type || "") : "";

  //looks like createFieldArrayDefinitions treats types with [] differently
  if (fieldType.toLowerCase().indexOf('object') >= 0 || fieldType.toLowerCase() == 'array' || isResult) {
    //if object or array of objects - create object definition
    if (fieldType.toLowerCase() == 'object[]') {
      fields[0].type = 'Array';
    }
    var fieldArrayResult = createFieldArrayDefinitions(fields, definitions, defName, objName);
    if ((fieldArrayResult.topLevelRefType.toLowerCase() == 'object') || isResult) {
      schema["$ref"] = "#/definitions/" + fieldArrayResult.topLevelRef;
    }
    else {
      schema["type"] = "array";
      schema["items"] = {
        "$ref": "#/definitions/" + fieldArrayResult.topLevelRef
      };
    }
  }
  else {
    //simple type or array of simple type
    if (fieldType.indexOf('[]') >= 0) {
      schema["type"] = "array";
      const itemType = fieldType.replace('[]', '');
      if (swagger.definitions.hasOwnProperty(itemType)) {
        schema["items"] = {
          "$ref": '#/definitions/' + itemType
        };
      }
      else {
        schema["items"] = {
          "type": itemType.toLowerCase()
        };
      }
    }
    else if (swagger.definitions.hasOwnProperty(fieldType)) {
      schema['$ref'] = '#/definitions/' + fieldType;
    }
    else {
      schema["type"] = fieldType.toLowerCase();
    }
  }
  return schema;
}

function createSuccessResults(verbs, definitions) {
  return _.mapValues(verbs.success ? verbs.success.fields : [], function (success, key) {
    var result = {"description": key};
    const postfix = convertToCamelCase(key);
    if (success.length > 0 && success[0].field && success[0].field != 'null'
      && success[0].type && success[0].type != 'null') {
      result.schema = createSchema(success, definitions, verbs.name + postfix, verbs.name + postfix, true);
    }
    return result;
  });
}

function createErrorResults(verbs, definitions) {
  var results = {};
  for(var key in verbs.error.fields) {
    var errorItem = verbs.error.fields[key];
    const postfix = convertToCamelCase(key);
    for(var itemKey in errorItem) {
      var desc = removeTags(errorItem[itemKey].description);
      //brightcove errors are XXX: description
      var code = desc.split(':')[0];
      var type = errorItem[itemKey].field;
      //we can have multiple desciptions for the same code
      if(!results[code]) {
        results[code] = {
          description: type + ':' + desc.split(':')[1]
        };
      } else {
        results[code].description = results[code].description + "\n" + type + ':' + desc.split(':')[1]
      }
    }
  }
  /*
  return _.mapValues(verbs.error ? verbs.error.fields : [], function (err, key) {
    const postfix = convertToCamelCase(key);
    console.log(err);
    console.log("");
    return {
      "description": key,
      "schema": createSchema(err, definitions, verbs.name + postfix, verbs.name + postfix, true)
    }
  });
  */
  return results;
}

function createParameters(fields, place) {
  return fields.map(function (param) {
    var field = param.field;
    var type = param.type;
    return {
      name: field,
      in: place,
      required: !param.optional,
      type:  param.type ? param.type.toLowerCase() : "string",
      description: removeTags(param.description)
    };
  });
}

function groupByUrl(apidocJson) {
  return _.chain(apidocJson)
    .groupBy("url")
    .pairs()
    .map(function (element) {
      return _.object(_.zip(["url", "verbs"], element));
    })
    .value();
}

module.exports = {
  toSwagger: toSwagger
};
